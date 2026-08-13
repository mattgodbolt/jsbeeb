import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import Papa from "papaparse";
import { parseFingerprints } from "../../tools/beebjit-fingerprint.js";
import {
    blobsAndManifestDisagree,
    compareFingerprints,
    diffManifests,
    findCollision,
    parseCatalogue,
} from "../../tools/mirror-bbcdiscs.js";

const Headers = [
    "Publisher",
    "Title",
    "Disc",
    "Tracks",
    "HFE Grab version",
    "CRC32",
    "CRC32 as 40 tracks (if 80 track disc)",
    "Variant",
    "DFS title",
    "DFS cycle number",
    "Birthday (YY/MM/DD)",
    "HFE link",
    "Submitter",
    "TRKS or scp files link",
    "Duplicates",
    "Notes",
];

const link = (id) => `https://drive.google.com/file/d/${id}/view`;

const sheet = (...rows) =>
    Papa.parse([Headers.join(","), ...rows].join("\n"), { header: true, skipEmptyLines: false }).data;

// A made-up flippy: one 40 track side and one 80 track side, so every per-side
// column holds two values and the two density rules both come into play.
const FlippyRow =
    `Testsoft,Flippy Demo,D1DS,"40, 80 (dual)",3,"AAAA0001, AAAA0002","AAAA0001, AAAA0003",1,` +
    `"T E S T, T E S T","40, 80",84/09/06,${link("1flippy00000000000000000000")},tester,,,Protection: none`;

// What beebjit prints for it. Side 0 is double stepped, so the fingerprint the
// sheet records for it is the even-track one, not the whole surface.
const FlippyFingerprints = `info:disc:HFE: v3 loading 2 sides, 81 tracks
info:disc:disc side 0 CRC32 fingerprint AAAA0009 title T E S T count 40
info:disc:disc side 0, as 40 track, CRC32 fingerprint AAAA0001
info:disc:disc side 1 CRC32 fingerprint AAAA0002 title T E S T count 80
info:disc:disc side 1, as 40 track, CRC32 fingerprint AAAA0003`;

const singleSided = (overrides) => ({
    ...parseCatalogue(sheet(FlippyRow)).entries[0],
    tracks: ["40"],
    crc32: ["BBBB0001"],
    crc32As40: [],
    dfsTitle: ["TESTDISC"],
    dfsCycle: ["04"],
    ...overrides,
});

describe("parseCatalogue", () => {
    it("splits the per-side columns of a two-sided disc", () => {
        const { entries } = parseCatalogue(sheet(FlippyRow));
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            title: "Flippy Demo",
            tracks: ["40", "80 (dual)"],
            crc32: ["AAAA0001", "AAAA0002"],
            crc32As40: ["AAAA0001", "AAAA0003"],
            dfsTitle: ["T E S T", "T E S T"],
            dfsCycle: ["40", "80"],
            blob: "AAAA0001-AAAA0002.hfe",
        });
    });

    it("treats a row with no link as withheld rather than as a fault", () => {
        const { entries, withheld, problems } = parseCatalogue(
            sheet("Testsoft,Unpublished Game,D1S1,40,3,BBBB0001,,1,<blank>,48,86/12/11,,tester,,,"),
        );
        expect(entries).toEqual([]);
        expect(problems).toEqual([]);
        expect(withheld).toEqual([{ publisher: "Testsoft", title: "Unpublished Game", disc: "D1S1", tracks: "40" }]);
    });

    it("skips the blank spacer rows entirely", () => {
        const { entries, withheld } = parseCatalogue(sheet(",,,,,,,,,,,,,,,", FlippyRow));
        expect(entries).toHaveLength(1);
        expect(withheld).toEqual([]);
    });

    it("reports a link used by two different discs instead of dropping one", () => {
        const shared = link("1shared00000000000000000000");
        const { entries, problems } = parseCatalogue(
            sheet(
                `Testsoft,First,D1S1,80,3,BBBB0001,BBBB0002,1,<blank>,04,none,${shared},tester,,,`,
                `Testsoft,Second,D1S1,40,3,BBBB0003,,1,<blank>,04,none,${shared},tester,,,`,
            ),
        );
        expect(entries).toHaveLength(1);
        expect(problems).toEqual([expect.stringContaining("reuses the Drive link already claimed by")]);
    });

    it("reports two discs claiming the same blob name", () => {
        const { entries, problems } = parseCatalogue(
            sheet(
                `Testsoft,One,D1S1,40,3,CCCC0001,,1,<blank>,04,none,${link("1aaaaaaaaaaaaaaaaaaaaaaaaaa")},t,,,`,
                `Testsoft,Two,D1S1,40,3,CCCC0001,,1,<blank>,04,none,${link("1bbbbbbbbbbbbbbbbbbbbbbbbbb")},t,,,`,
            ),
        );
        expect(entries).toHaveLength(1);
        expect(problems).toEqual([expect.stringContaining("want the blob CCCC0001.hfe")]);
    });

    it("reports a link it cannot find a file id in", () => {
        const { entries, problems } = parseCatalogue(
            sheet("Testsoft,Odd,D1S1,40,3,DDDD0001,,1,<blank>,04,none,https://example.com/nope,t,,,"),
        );
        expect(entries).toEqual([]);
        expect(problems).toEqual([expect.stringContaining("cannot find a Drive file id")]);
    });

    // A DFS title is 12 arbitrary bytes, so a comma in one is part of the title
    // rather than the separator between two sides.
    it("keeps a comma inside a single-sided disc's DFS title", () => {
        const { entries } = parseCatalogue(
            sheet(
                `Testsoft,Commas,D1S1,40,3,BBBB0001,,1,"2201,181-01",04,none,${link("1comma000000000000000000000")},t,,,`,
            ),
        );
        expect(entries[0].dfsTitle).toEqual(["2201,181-01"]);
    });

    it("still splits a DFS title per side when there is one for each", () => {
        expect(parseCatalogue(sheet(FlippyRow)).entries[0].dfsTitle).toEqual(["T E S T", "T E S T"]);
    });

    // Dropping the gap would slide side 1's value into side 0's place and
    // reject a perfectly good disc.
    it("keeps a blank side in its place", () => {
        const { entries } = parseCatalogue(
            sheet(
                `Testsoft,Gappy,D1DS,"40, 80",3,"AAAA0001, AAAA0002",", AAAA0003",1,` +
                    `"T, T",", 80",none,${link("1gappy000000000000000000000")},t,,,`,
            ),
        );
        expect(entries[0].crc32As40).toEqual(["", "AAAA0003"]);
        expect(entries[0].dfsCycle).toEqual(["", "80"]);
    });

    it("rejects a row missing a CRC32 for one of its sides", () => {
        const { entries, problems } = parseCatalogue(
            sheet(
                `Testsoft,Half,D1DS,"40, 80",3,", AAAA0002",,1,"T, T","04, 04",none,${link("1half0000000000000000000000")},t,,,`,
            ),
        );
        expect(entries).toEqual([]);
        expect(problems).toEqual([expect.stringContaining("needs a CRC32 for every side")]);
    });

    it("names the blob after the fingerprint, not the sheet's prose", () => {
        const [before] = parseCatalogue(sheet(FlippyRow)).entries;
        const [after] = parseCatalogue(sheet(FlippyRow.replace(",Flippy Demo,", ",Flippy Demoe,"))).entries;
        expect(after.blob).toBe(before.blob);
    });
});

describe("parseFingerprints", () => {
    it("reads both fingerprints and the DFS metadata for each side", () => {
        expect(parseFingerprints(FlippyFingerprints)).toEqual([
            { full: "AAAA0009", as40: "AAAA0001", dfsTitle: "T E S T", dfsCycle: "40" },
            { full: "AAAA0002", as40: "AAAA0003", dfsTitle: "T E S T", dfsCycle: "80" },
        ]);
    });

    it("copes with a disc that has no DFS catalogue", () => {
        const output = "info:disc:disc side 0 CRC32 fingerprint BBBB0001 title  count FFFFFFFF";
        expect(parseFingerprints(output)[0]).toMatchObject({ full: "BBBB0001", dfsTitle: "", dfsCycle: "FFFFFFFF" });
    });

    it("reports only one side for a single-sided disc", () => {
        expect(parseFingerprints("info:disc:disc side 0 CRC32 fingerprint BBBB0001 title TEST count 02")).toHaveLength(
            1,
        );
    });
});

describe("compareFingerprints", () => {
    const flippy = () => parseCatalogue(sheet(FlippyRow)).entries[0];

    it("accepts a disc matching every column the sheet claims", () => {
        expect(compareFingerprints(flippy(), parseFingerprints(FlippyFingerprints))).toEqual([]);
    });

    it("reads a 40 track side's fingerprint from its even tracks", () => {
        // Picking the whole-surface fingerprint here would fail a good disc.
        const sides = parseFingerprints(FlippyFingerprints);
        expect(sides[0].full).not.toBe(flippy().crc32[0]);
        expect(compareFingerprints(flippy(), sides)).toEqual([]);
    });

    it("catches a disc whose 80 track side has drifted from the sheet", () => {
        const sides = parseFingerprints(FlippyFingerprints.replace("AAAA0002", "AAAA000F"));
        expect(compareFingerprints(flippy(), sides)).toEqual(["side 1 CRC32: sheet says AAAA0002, disc says AAAA000F"]);
    });

    it("catches a mismatched DFS cycle number", () => {
        const sides = parseFingerprints(FlippyFingerprints.replace("count 80", "count 81"));
        expect(compareFingerprints(flippy(), sides)).toEqual(["side 1 DFS cycle number: sheet says 80, disc says 81"]);
    });

    it("reports a column the sheet filled in but the disc has nothing to say about", () => {
        const entry = singleSided({ crc32As40: ["AAAA0003"] });
        const sides = parseFingerprints("info:disc:disc side 0 CRC32 fingerprint BBBB0001 title TESTDISC count 04");
        expect(compareFingerprints(entry, sides)).toEqual([
            "side 0 CRC32 as 40 tracks: sheet says AAAA0003, disc reports none",
        ]);
    });

    it("leaves the other sides alone when a column only describes the first", () => {
        const sides = parseFingerprints(FlippyFingerprints);
        expect(compareFingerprints({ ...flippy(), dfsCycle: ["40"] }, sides)).toEqual([]);
    });

    it("notices when the disc has fewer sides than the sheet describes", () => {
        const sides = parseFingerprints(FlippyFingerprints.split("\n").slice(0, 3).join("\n"));
        expect(compareFingerprints(flippy(), sides)).toEqual(["sheet describes 2 side(s), disc has 1"]);
    });

    // beebjit writes `?` for any byte of a title that isn't printable, and the
    // sheet copies it verbatim, so it compares as an ordinary character rather
    // than as a marker meaning "unsure".
    it("matches a DFS title containing beebjit's placeholder for unprintable bytes", () => {
        const entry = singleSided({ dfsTitle: ["?Test?"] });
        const sides = parseFingerprints("info:disc:disc side 0 CRC32 fingerprint BBBB0001 title ?Test?  count 04");
        expect(compareFingerprints(entry, sides)).toEqual([]);
    });

    it("still reports a DFS title that genuinely differs", () => {
        const entry = singleSided({ dfsTitle: ["?Test?"] });
        const sides = parseFingerprints("info:disc:disc side 0 CRC32 fingerprint BBBB0001 title Test count 04");
        expect(compareFingerprints(entry, sides)).toEqual(['side 0 DFS title: sheet says "?Test?", disc says "Test"']);
    });

    it.each(["<blank>", "<empty>"])("accepts %s against a disc with no DFS title", (marker) => {
        const entry = singleSided({ dfsTitle: [marker] });
        const sides = parseFingerprints("info:disc:disc side 0 CRC32 fingerprint BBBB0001 title  count 04");
        expect(compareFingerprints(entry, sides)).toEqual([]);
    });

    it("reports a disc that has a DFS title where the sheet says it has none", () => {
        const entry = singleSided({ dfsTitle: ["<blank>"] });
        const sides = parseFingerprints("info:disc:disc side 0 CRC32 fingerprint BBBB0001 title TESTDISC count 04");
        expect(compareFingerprints(entry, sides)).toEqual([
            'side 0 DFS title: sheet says "<blank>", disc says "TESTDISC"',
        ]);
    });
});

describe("findCollision", () => {
    const file = (path) => ({ path });

    it("passes two sources whose names cannot overlap", () => {
        expect(
            findCollision([
                ["hfe", [file("AABBCCDD.hfe"), file("AABBCCDD-11223344.hfe")]],
                ["fsd", [file("0123456789abcdef.hfe")]],
            ]),
        ).toBeNull();
    });

    it("names both sources when one blob is claimed twice", () => {
        expect(
            findCollision([
                ["hfe", [file("AABBCCDD.hfe")]],
                ["fsd", [file("AABBCCDD.hfe")]],
            ]),
        ).toEqual({ path: "AABBCCDD.hfe", sources: ["hfe", "fsd"] });
    });
});

/**
 * A whole run, with a stand-in for beebjit and no network: the catalogued disc
 * is already published, which is the path a mirror seeded from S3 takes, and
 * the reconstructed ones are read from a directory.
 */
describe("a full run", () => {
    const Tool = fileURLToPath(new URL("../../tools/mirror-bbcdiscs.js", import.meta.url));
    const CapturedCrc = "AABBCCDD";
    const CapturedRow =
        `Somesoft,Some Game,D1DS,40,3,${CapturedCrc},,1,TEST,04,84/09/06,` +
        `${link("1captured0000000000000000000")},tester,,,`;
    const hfeImage = (fill) => Buffer.concat([Buffer.from("HXCHFEV3", "latin1"), Buffer.alloc(64, fill)]);

    let dir;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "mirror-test-"));

        const beebjit = join(dir, "beebjit");
        await writeFile(
            beebjit,
            "#!/bin/sh\n" + `echo "info:disc:disc side 0 CRC32 fingerprint ${CapturedCrc} title TEST count 04"\n`,
        );
        await chmod(beebjit, 0o755);

        await writeFile(join(dir, "sheet.csv"), `${Headers.join(",")}\n${CapturedRow}\n`);

        // Already published, so it is decompressed in place rather than fetched.
        await mkdir(join(dir, "out", "hfe"), { recursive: true });
        await writeFile(join(dir, "out", "hfe", `${CapturedCrc}.hfe`), brotliCompressSync(hfeImage(0x11)));

        await mkdir(join(dir, "fsd", "Othersoft"), { recursive: true });
        await writeFile(join(dir, "fsd", "Othersoft", "Rebuilt_Game_FSD123.hfe"), hfeImage(0x22));
        await writeFile(join(dir, "fsd", "Othersoft", "Another_Game.hfe"), hfeImage(0x33));
    });

    afterEach(async () => await rm(dir, { recursive: true, force: true }));

    const run = (...extra) =>
        new Promise((resolve, reject) => {
            const args = [
                Tool,
                "--csv",
                join(dir, "sheet.csv"),
                "--fsd",
                join(dir, "fsd"),
                "--out",
                join(dir, "out"),
                "--beebjit",
                join(dir, "beebjit"),
                ...extra,
            ];
            const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            let output = "";
            child.stdout.on("data", (chunk) => (output += chunk));
            child.stderr.on("data", (chunk) => (output += chunk));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, output }));
        });

    const manifest = async () => JSON.parse(await readFile(join(dir, "out", "hfe", "manifest.json"), "utf8"));
    const blobs = async () => (await readdir(join(dir, "out", "hfe"))).filter((n) => n.endsWith(".hfe")).sort();

    it("gathers every source into one manifest beside one set of blobs", async () => {
        const { code } = await run();
        expect(code).toBe(0);

        const files = (await manifest()).files;
        expect(files.map((f) => [f.title, f.provenance])).toEqual([
            ["Some Game", "captured"],
            ["Another Game", "reconstructed"],
            ["Rebuilt Game", "reconstructed"],
        ]);
        expect(await blobs()).toHaveLength(3);
        // Bare names, so a link to a disc says nothing about where it came from.
        expect(files.every((f) => !f.path.includes("/"))).toBe(true);
    });

    it("says the same thing when run again over what it just built", async () => {
        expect((await run()).code).toBe(0);
        const first = await readFile(join(dir, "out", "hfe", "manifest.json"), "utf8");
        const firstBlobs = await blobs();

        expect((await run()).code).toBe(0);
        expect(await readFile(join(dir, "out", "hfe", "manifest.json"), "utf8")).toBe(first);
        expect(await blobs()).toEqual(firstBlobs);
    });

    // The upload compares modification times, so a blob rewritten with the same
    // bytes is still a blob re-uploaded.
    it("leaves the blobs it already has alone", async () => {
        expect((await run()).code).toBe(0);
        const written = async () =>
            Object.fromEntries(
                await Promise.all(
                    (await blobs()).map(async (name) => [name, (await stat(join(dir, "out", "hfe", name))).mtimeMs]),
                ),
            );
        const before = await written();

        expect((await run()).code).toBe(0);
        expect(await written()).toEqual(before);
    });

    // The upload deletes whatever the manifest leaves out, and the blobs are
    // shared, so this is what stops one source's run withdrawing the other's.
    it("leaves the other source's discs alone when only one source is run", async () => {
        expect((await run()).code).toBe(0);
        const before = await readFile(join(dir, "out", "hfe", "manifest.json"), "utf8");

        const { code, output } = await run("--only", "hfe");
        expect(code).toBe(0);
        expect(output).toContain("Partial run");
        expect(await blobs()).toHaveLength(3);
        expect(await readFile(join(dir, "out", "hfe", "manifest.json"), "utf8")).toBe(before);
    });

    // Two dumps of one disc are one blob. Which of them names it must not
    // depend on which worker got there first.
    it("publishes byte-identical discs once, always describing them the same way", async () => {
        await writeFile(join(dir, "fsd", "Othersoft", "Copy_Of_Another_Game.hfe"), hfeImage(0x33));

        const seen = new Set();
        for (let attempt = 0; attempt < 3; attempt++) {
            await rm(join(dir, "out", "hfe"), { recursive: true, force: true });
            await mkdir(join(dir, "out", "hfe"), { recursive: true });
            await writeFile(join(dir, "out", "hfe", `${CapturedCrc}.hfe`), brotliCompressSync(hfeImage(0x11)));
            const { code, output } = await run();
            expect(code).toBe(0);
            expect(output).toContain("DUPLICATE");
            const titles = (await manifest()).files.map((f) => f.title);
            expect(titles).toHaveLength(3);
            seen.add(titles.join("|"));
        }
        expect([...seen]).toHaveLength(1);
    });

    // Far more likely than an archive being emptied is a tree that never
    // mounted, and taking it at its word withdraws everything it published.
    it("refuses to withdraw everything when a source finds nothing at all", async () => {
        expect((await run()).code).toBe(0);
        const before = await readFile(join(dir, "out", "hfe", "manifest.json"), "utf8");
        await rm(join(dir, "fsd"), { recursive: true });
        await mkdir(join(dir, "fsd"));

        const { code, output } = await run();
        expect(code).not.toBe(0);
        expect(output).toContain("found no discs at all");
        expect(await blobs()).toHaveLength(3);
        expect(await readFile(join(dir, "out", "hfe", "manifest.json"), "utf8")).toBe(before);
    });

    // Its shared links have to keep resolving while the disagreement is sorted
    // out, so it loses its place in the manifest but not its blob.
    it("keeps the blob of a catalogued disc that stops matching the sheet", async () => {
        expect((await run()).code).toBe(0);
        await writeFile(join(dir, "sheet.csv"), `${Headers.join(",")}\n${CapturedRow.replace(",TEST,", ",OTHER,")}\n`);

        const { code, output } = await run("--reverify");
        expect(code).not.toBe(0);
        expect(output).toContain("FAILED");
        expect(output).not.toContain(`WITHDRAWN ${CapturedCrc}.hfe`);
        expect(await blobs()).toContain(`${CapturedCrc}.hfe`);
        expect((await manifest()).files.map((f) => f.provenance)).toEqual(["reconstructed", "reconstructed"]);
    });

    it("drops a disc the catalogue no longer lists, and its blob with it", async () => {
        expect((await run()).code).toBe(0);
        // Swapped for a different disc rather than emptied, so this is a
        // withdrawal and not a catalogue that failed to load.
        await writeFile(join(dir, "out", "hfe", "BBBBCCDD.hfe"), brotliCompressSync(hfeImage(0x44)));
        await writeFile(
            join(dir, "sheet.csv"),
            `${Headers.join(",")}\n${CapturedRow.replace(CapturedCrc, "BBBBCCDD")}\n`,
        );

        const { code, output } = await run();
        expect(code).toBe(0);
        expect(output).toContain(`WITHDRAWN ${CapturedCrc}.hfe`);
        expect((await manifest()).files.map((f) => f.path)).toContain("BBBBCCDD.hfe");
        expect(await blobs()).not.toContain(`${CapturedCrc}.hfe`);
        expect(await blobs()).toHaveLength(3);
    });
});

describe("diffManifests", () => {
    const file = (path, overrides = {}) => ({ path, size: 100, title: path, ...overrides });
    const manifest = (...files) => ({ files });

    it("says nothing needs doing when the two agree", () => {
        const both = manifest(file("AAAA0001.hfe"), file("AAAA0002.hfe"));
        expect(diffManifests(both, both)).toEqual({ added: [], removed: [], suspect: [], sizeDelta: 0 });
    });

    it("separates what would arrive from what would be withdrawn", () => {
        const diff = diffManifests(
            manifest(file("AAAA0001.hfe"), file("bbbbbbbbbbbbbbbb.hfe")),
            manifest(file("AAAA0001.hfe"), file("AAAA0002.hfe")),
        );
        expect(diff.added.map((f) => f.path)).toEqual(["bbbbbbbbbbbbbbbb.hfe"]);
        expect(diff.removed.map((f) => f.path)).toEqual(["AAAA0002.hfe"]);
    });

    it("counts a first upload as all additions", () => {
        const diff = diffManifests(manifest(file("A.hfe"), file("B.hfe")), manifest());
        expect(diff.added).toHaveLength(2);
        expect(diff.removed).toEqual([]);
    });

    // The name is a fingerprint or a hash of the bytes either way, so the same
    // name over different bytes means one of the two is not what it says.
    it("calls out a published blob whose size has moved under it", () => {
        const diff = diffManifests(manifest(file("A.hfe", { size: 500 })), manifest(file("A.hfe", { size: 200 })));
        expect(diff.suspect).toEqual(["A.hfe: published as 200 bytes, built as 500"]);
        expect(diff.sizeDelta).toBe(300);
    });
});

describe("blobsAndManifestDisagree", () => {
    const manifest = (...paths) => ({ files: paths.map((path) => ({ path })) });

    it("passes a directory holding exactly what the manifest names", () => {
        expect(blobsAndManifestDisagree(manifest("A.hfe"), new Set(["A.hfe", "manifest.json"]))).toEqual({
            missing: [],
            unexpected: [],
        });
    });

    it("names a disc the manifest promises and the directory does not have", () => {
        expect(blobsAndManifestDisagree(manifest("A.hfe", "B.hfe"), new Set(["A.hfe"])).missing).toEqual(["B.hfe"]);
    });

    // The upload sends the directory, so this would be published regardless.
    it("names a file that would be uploaded without the manifest mentioning it", () => {
        const disagree = blobsAndManifestDisagree(manifest("A.hfe"), new Set(["A.hfe", "A.hfe.0.part"]));
        expect(disagree.unexpected).toEqual(["A.hfe.0.part"]);
    });
});
