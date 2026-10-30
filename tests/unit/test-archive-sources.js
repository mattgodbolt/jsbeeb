import { afterEach, describe, expect, it, vi } from "vitest";

import GitHubDiscs from "../../src/web/github-discs.json";
import { addArchiveSources } from "../../src/web/archive-sources.js";
import { MachineRequirements, describeGitHubEntry, requirementOf } from "../../src/web/media-catalogue.js";
import { StairwayToHell } from "../../src/sth.js";
import { BbcDiscArchive } from "../../src/bbcdiscs.js";
import { BitshiftersArchive } from "../../src/bitshifters.js";

const register = () => {
    const media = { fetchers: new Map(), listers: new Map(), describers: new Map() };
    addArchiveSources({
        addSource: (schema, fetcher) => media.fetchers.set(schema, fetcher),
        addLister: (source, lister) => media.listers.set(source, lister),
        addDescriber: (source, describer) => media.describers.set(source, describer),
    });
    return media;
};

const fetchesOwnArchive = (Archive) =>
    vi.spyOn(Archive.prototype, "fetch").mockImplementation(async function (path) {
        return { archive: this, path };
    });

const Paradroid = {
    path: "bs-paradroid.ssd",
    title: "Paradroid",
    publisher: "Bitshifters",
    year: 2026,
    type: "Game",
    machine: "Master",
    url: "https://bitshifters.github.io/posts/prods/bs-paradroid.html",
};

describe("addArchiveSources", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        ["hfe", BbcDiscArchive, "Games/ELITE.hfe"],
        ["bitshifters", BitshiftersArchive, "bs-paradroid.ssd"],
    ])("hands the loader a %s fetcher that asks its archive", async (schema, Archive, path) => {
        fetchesOwnArchive(Archive);
        const fetched = await register().fetchers.get(schema)(path);
        expect(fetched.archive).toBeInstanceOf(Archive);
        expect(fetched.path).toBe(path);
    });

    it("registers no other fetcher, since the resolver loads any github: reference by its URL", () => {
        expect([...register().fetchers.keys()].sort()).toEqual(["bitshifters", "hfe", "sth", "tapeSth"]);
    });

    it.each([
        [
            "hfe",
            BbcDiscArchive,
            [{ path: "Games/ELITE.hfe", title: "Elite", publisher: "Acornsoft", provenance: "captured" }],
            { ref: "hfe:Games/ELITE.hfe", kind: "disc", title: "Elite", source: "hfe" },
        ],
        [
            "bitshifters",
            BitshiftersArchive,
            [Paradroid],
            { ref: "bitshifters:bs-paradroid.ssd", kind: "disc", title: "Paradroid", url: Paradroid.url },
        ],
    ])("lists %s for the media window", async (source, Archive, catalogue, expected) => {
        vi.spyOn(Archive.prototype, "catalogue").mockResolvedValue(catalogue);
        expect(await register().listers.get(source)()).toEqual([expect.objectContaining(expected)]);
    });

    it("fetches and lists Stairway to Hell's discs and tapes each from its own catalogue", async () => {
        fetchesOwnArchive(StairwayToHell);
        const media = register();
        const disc = await media.fetchers.get("sth")("Acornsoft/Elite.zip");
        const tape = await media.fetchers.get("tapeSth")("AnF/ChuckieEgg.zip");
        expect([disc.path, tape.path]).toEqual(["Acornsoft/Elite.zip", "AnF/ChuckieEgg.zip"]);
        expect(disc.archive).not.toBe(tape.archive);
        const catalogues = new Map([
            [disc.archive, [disc.path]],
            [tape.archive, [tape.path]],
        ]);
        vi.spyOn(StairwayToHell.prototype, "catalogue").mockImplementation(async function () {
            return catalogues.get(this);
        });
        expect(await media.listers.get("sth")()).toEqual([
            expect.objectContaining({ ref: "sth:Acornsoft/Elite.zip", kind: "disc", title: "Elite" }),
            expect.objectContaining({ ref: "sth:AnF/ChuckieEgg.zip", kind: "tape", title: "ChuckieEgg" }),
        ]);
    });

    it("describes a Bitshifters release by its path, with the machine it needs", async () => {
        vi.spyOn(BitshiftersArchive.prototype, "catalogue").mockResolvedValue([Paradroid]);
        const describer = register().describers.get("bitshifters");
        expect(await describer("bs-paradroid.ssd")).toMatchObject({
            title: "Paradroid",
            requires: { model: "Master" },
        });
        expect(await describer("nope.ssd")).toBeUndefined();
    });

    it("lists every disc in the bundled GitHub list", async () => {
        const listed = await register().listers.get("github")();
        expect(listed).toEqual(GitHubDiscs.map(describeGitHubEntry));
        expect(listed.every((d) => d.source === "github" && d.ref.startsWith("github:"))).toBe(true);
    });

    it("describes a listed GitHub disc by its reference, with the machine it needs", async () => {
        const describer = register().describers.get("github");
        expect(await describer("mattgodbolt/nm/ninja_music.ssd")).toMatchObject({
            title: "Ninja Massacre music",
            requires: MachineRequirements.Master,
        });
        expect(await describer("mattgodbolt/frogman@classic/frogman_rebuilt.ssd")).toMatchObject({
            title: "Frogman (classic)",
        });
        expect(await describer("someone/else/disc.ssd")).toBeUndefined();
    });

    describe("the bundled GitHub list", () => {
        const Required = ["repo", "path", "title", "publisher", "year", "type"];
        const Known = new Set([...Required, "ref", "authors", "machine", "needs", "url"]);

        it.each(GitHubDiscs.map((entry) => [describeGitHubEntry(entry).ref, entry]))(
            "%s has what an entry needs, and nothing the list does not know",
            (_name, entry) => {
                for (const field of Required) expect(entry[field], field).toBeTruthy();
                expect(Object.keys(entry).filter((field) => !Known.has(field))).toEqual([]);
                expect(entry.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
                expect(entry.path).not.toMatch(/^\//);
                expect(Number.isInteger(entry.year)).toBe(true);
                if (entry.ref !== undefined) expect(entry.ref).toMatch(/^[^/\s]+$/);
                if (entry.machine !== undefined) expect(Object.keys(MachineRequirements)).toContain(entry.machine);
                if (entry.needs !== undefined) expect(Array.isArray(entry.needs), "needs is a list").toBe(true);
                for (const name of entry.needs ?? [])
                    expect(requirementOf({ needs: [name] }), `needs ${name}`).toBeDefined();
                if (entry.url !== undefined) expect(new URL(entry.url).protocol).toBe("https:");
            },
        );

        it("names each disc once", () => {
            const refs = GitHubDiscs.map((entry) => describeGitHubEntry(entry).ref);
            expect(new Set(refs).size).toBe(refs.length);
        });
    });
});
