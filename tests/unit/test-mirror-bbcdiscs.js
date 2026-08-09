import { describe, expect, it } from "vitest";
import { compareFingerprints, parseCatalogue, parseCsv, parseFingerprints } from "../../tools/mirror-bbcdiscs.js";

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

const sheet = (...rows) => parseCsv([Headers.join(","), ...rows].join("\n"));

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

describe("parseCsv", () => {
    it("keeps commas inside quoted fields", () => {
        expect(parseCsv('a,b\n"one, two",three')).toEqual([{ a: "one, two", b: "three" }]);
    });

    it("unescapes doubled quotes", () => {
        expect(parseCsv('a\n"he said ""hi"""')).toEqual([{ a: 'he said "hi"' }]);
    });

    it("handles newlines inside quoted fields", () => {
        expect(parseCsv('a,b\n"line one\nline two",x')).toEqual([{ a: "line one\nline two", b: "x" }]);
    });

    it("pads rows that stop short of the header", () => {
        expect(parseCsv("a,b,c\n1,2")).toEqual([{ a: "1", b: "2", c: "" }]);
    });

    it("keeps the blank spacer rows a sheet uses between sections", () => {
        const rows = parseCsv("a,b\n1,2\n,\n3,4");
        expect(rows).toHaveLength(3);
        expect(rows[1]).toEqual({ a: "", b: "" });
    });
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
