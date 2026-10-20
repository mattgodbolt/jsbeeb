// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    MachineRequirements,
    RecentMedia,
    browserDiscNames,
    describeBitshiftersEntry,
    describeBrowserDisc,
    describeBuiltIn,
    describeDriveFile,
    describeGitHubEntry,
    describeHfeEntry,
    describeSessionFile,
    describeSthDisc,
    describeSthTape,
    compareForQuery,
    matchesQuery,
    requirementName,
    requirementOf,
    satisfiesRequirement,
    scoreQuery,
    sourceOf,
} from "../../src/web/media-catalogue.js";
import { Provenance } from "../../src/bbcdiscs.js";
import { findModel } from "../../src/models.js";
import { Parameters } from "../../src/web/parameters.js";
import { Schemas } from "../../src/media-resolver.js";

describe("the media catalogue", () => {
    afterEach(() => window.localStorage.clear());

    describe("STH", () => {
        it("reads the publisher and title out of the path", () => {
            expect(describeSthDisc("Acornsoft/Elite.zip")).toEqual({
                ref: "sth:Acornsoft/Elite.zip",
                kind: "disc",
                title: "Elite",
                publisher: "Acornsoft",
                detail: "",
                source: "sth",
                savesChanges: false,
            });
        });

        it("copes with a path that has no publisher, and names tapes as tapes", () => {
            const tape = describeSthTape("Chuckie.ZIP");
            expect(tape.kind).toBe("tape");
            expect(tape.title).toBe("Chuckie");
            expect(tape.publisher).toBe("");
        });
    });

    describe("the HFE archive", () => {
        it("carries the archive's metadata through", () => {
            const entry = {
                path: "3A1DAB83.hfe",
                title: "Calligraphy",
                publisher: "Acorn User",
                disc: "D1DS",
                tracks: ["40"],
                variant: "1",
                provenance: Provenance.Captured,
            };
            expect(describeHfeEntry(entry)).toEqual({
                ref: "hfe:3A1DAB83.hfe",
                kind: "disc",
                title: "Calligraphy",
                publisher: "Acorn User",
                detail: "D1DS · 40 · v1",
                source: "hfe",
                savesChanges: false,
            });
        });

        it("files a reconstructed disc under its own source", () => {
            const described = describeHfeEntry({ path: "x.hfe", title: "X", provenance: Provenance.Reconstructed });
            expect(described.source).toBe("hfeRebuilt");
        });
    });

    describe("Bitshifters", () => {
        it("carries the site's metadata through, with the page that presents the release", () => {
            const entry = {
                path: "bs-paradroid.ssd",
                title: "Paradroid",
                publisher: "Bitshifters",
                authors: "Kieran, Hexwab",
                year: 2026,
                type: "Game",
                machine: "Master",
                url: "https://bitshifters.github.io/posts/prods/bs-paradroid.html",
            };
            expect(describeBitshiftersEntry(entry)).toEqual({
                ref: "bitshifters:bs-paradroid.ssd",
                kind: "disc",
                title: "Paradroid",
                publisher: "Bitshifters",
                detail: "Game · Master · 2026 · Kieran, Hexwab",
                source: "bitshifters",
                savesChanges: false,
                url: "https://bitshifters.github.io/posts/prods/bs-paradroid.html",
                requires: { model: "Master", coProcessor: false, name: "BBC Master 128" },
            });
        });

        it("carries the machine an entry needs from the table, and nothing for a name outside it", () => {
            const requiredBy = (machine) => describeBitshiftersEntry({ path: "x.ssd", machine }).requires;
            expect(requiredBy("MasterTurbo")).toBe(MachineRequirements.MasterTurbo);
            for (const machine of [undefined, "Electron", "constructor", "__proto__"])
                expect(requiredBy(machine)).toBeUndefined();
        });

        it("strips the markup the manifest carries, and leaves out what an entry does not have", () => {
            const described = describeBitshiftersEntry({
                path: "0xc0de-elementum.ssd",
                title: "Elementum",
                publisher: "<span>0xC0DE</span>",
                authors: '<a href="https://example.com/0xC0DE">0xC0DE</a>',
                year: 2020,
                type: "Game",
                machine: "Master",
            });
            expect(described.publisher).toBe("0xC0DE");
            expect(described.detail).toBe("Game · Master · 2020 · 0xC0DE");
            expect(described.url).toBeUndefined();
            expect(describeBitshiftersEntry({ path: "nj-beeb3d.ssd", title: "Beeb 3D", year: 1994 }).detail).toBe(
                "1994",
            );
        });
    });

    describe("GitHub", () => {
        const nm = {
            repo: "mattgodbolt/nm",
            path: "ninja_music.ssd",
            title: "Ninja Massacre music",
            publisher: "Matt Godbolt",
            authors: "Music by David Whittaker",
            year: 2026,
            type: "Music",
            machine: "Master",
        };

        it("names the disc at the repo's default branch, and links to the repo", () => {
            expect(describeGitHubEntry(nm)).toEqual({
                ref: "github:mattgodbolt/nm/ninja_music.ssd",
                kind: "disc",
                title: "Ninja Massacre music",
                publisher: "Matt Godbolt",
                detail: "Music · Master · 2026 · Music by David Whittaker",
                source: "github",
                savesChanges: false,
                url: "https://github.com/mattgodbolt/nm",
                requires: MachineRequirements.Master,
            });
        });

        it("names the ref an entry pins, takes the page it gives, and leaves out what it does not have", () => {
            const described = describeGitHubEntry({
                repo: "mattgodbolt/frogman",
                path: "discs/frogman rebuilt.ssd",
                ref: "classic",
                title: "Frogman (classic)",
                publisher: "Matt Godbolt",
                year: 1993,
                type: "Game",
                url: "https://example.com/frogman",
            });
            expect(described.ref).toBe("github:mattgodbolt/frogman@classic/discs/frogman rebuilt.ssd");
            expect(described.url).toBe("https://example.com/frogman");
            expect(described.detail).toBe("Game · 1993");
            expect(described.requires).toBeUndefined();
        });
    });

    describe("the fittings an entry needs", () => {
        const neededAs = Object.entries(Parameters).filter(([, { neededAs }]) => neededAs);

        it("are the settings the Parameters table says a disc may need, by the names it gives them", () => {
            expect(neededAs.map(([setting, { neededAs }]) => [setting, neededAs])).toEqual([
                ["hasVideoNula", "VideoNuLA"],
            ]);
            for (const [setting, { type, takenFromHost, neededAs: name }] of neededAs) {
                expect(type, setting).toBe("bool");
                expect(takenFromHost, `${setting}, which the machine switch reads among the session's`).toBe(true);
                expect(requirementOf({ needs: [name] }).fittings).toEqual({ [setting]: true });
            }
        });

        it("leave the model alone without a machine, and add to the machine's with one", () => {
            expect(requirementOf({ needs: ["VideoNuLA", "VideoNuLA"] })).toEqual({
                needs: ["VideoNuLA"],
                fittings: { hasVideoNula: true },
            });
            expect(requirementOf({ machine: "Master", needs: ["VideoNuLA"] })).toEqual({
                ...MachineRequirements.Master,
                needs: ["VideoNuLA"],
                fittings: { hasVideoNula: true },
            });
        });

        it("are named on the machine the user has, or the one the entry names", () => {
            const master = findModel("Master");
            expect(requirementName(requirementOf({ needs: ["VideoNuLA"] }), master)).toBe(
                "BBC Master 128 (DFS) with a VideoNuLA",
            );
            expect(requirementName(requirementOf({ needs: ["VideoNuLA"] }), findModel("B-DFS1.2"))).toBe(
                "BBC B with 8271 (DFS 1.2) and a VideoNuLA",
            );
            expect(requirementName(requirementOf({ machine: "MasterTurbo", needs: ["VideoNuLA"] }), master)).toBe(
                "BBC Master 128 with a 65C102 co-processor and a VideoNuLA",
            );
            expect(requirementName({ needs: ["Ultracard"] }, master)).toBe("BBC Master 128 (DFS) with an Ultracard");
            expect(requirementName(MachineRequirements.Master, findModel("B-DFS1.2"))).toBe("BBC Master 128");
        });

        it("ignore a name the table does not give, and a list that is not one", () => {
            for (const needs of [["Chameleon"], ["constructor"], [undefined], "VideoNuLA", 7, undefined])
                expect(requirementOf({ needs })).toBeUndefined();
            expect(requirementOf({ machine: "Master", needs: ["Chameleon"] })).toBe(MachineRequirements.Master);
        });

        it("come with an entry from either manifest", () => {
            const needs = ["VideoNuLA"];
            expect(describeBitshiftersEntry({ path: "x.ssd", needs }).requires.fittings).toEqual({
                hasVideoNula: true,
            });
            expect(describeGitHubEntry({ repo: "a/b", path: "x.ssd", needs }).requires.fittings).toEqual({
                hasVideoNula: true,
            });
        });

        it("are satisfied only by a machine started with them, whatever its model", () => {
            const nula = requirementOf({ needs: ["VideoNuLA"] });
            const machine = (name, fitted) => ({ model: findModel(name), hasTube: false, fitted });
            expect(satisfiesRequirement(nula, machine("B-DFS1.2", { hasVideoNula: true }))).toBe(true);
            expect(satisfiesRequirement(nula, machine("Master", { hasVideoNula: true }))).toBe(true);
            expect(satisfiesRequirement(nula, machine("B-DFS1.2", { hasVideoNula: false }))).toBe(false);
            expect(satisfiesRequirement(nula, machine("B-DFS1.2", undefined))).toBe(false);
            const masterNula = requirementOf({ machine: "Master", needs: ["VideoNuLA"] });
            expect(satisfiesRequirement(masterNula, machine("B-DFS1.2", { hasVideoNula: true }))).toBe(false);
            expect(satisfiesRequirement(masterNula, machine("Master", { hasVideoNula: true }))).toBe(true);
        });
    });

    it("holds a requirement to the very model named and the co-processor as named, nothing looser", () => {
        const machine = (name, hasTube = false) => ({ model: findModel(name), hasTube });
        const { Master, MasterTurbo } = MachineRequirements;
        expect(satisfiesRequirement(Master, machine("Master"))).toBe(true);
        expect(satisfiesRequirement(MasterTurbo, machine("Master", true))).toBe(true);
        for (const name of ["MasterADFS", "MasterANFS", "B-DFS1.2", "B1770"])
            expect(satisfiesRequirement(Master, machine(name))).toBe(false);
        expect(satisfiesRequirement(Master, machine("Master", true))).toBe(false);
        expect(satisfiesRequirement(MasterTurbo, machine("Master"))).toBe(false);
    });

    it("describes the built-in discs, Google Drive files, browser discs and session files", () => {
        expect(describeBuiltIn({ name: "Elite", desc: "A classic", file: "elite.ssd" })).toMatchObject({
            ref: "elite.ssd",
            title: "Elite",
            detail: "A classic",
            source: "builtin",
        });
        expect(describeDriveFile({ id: "abc", name: "mine.ssd", capabilities: { canEdit: true } })).toMatchObject({
            ref: "gd:abc/mine.ssd",
            source: "gdrive",
            savesChanges: true,
        });
        expect(describeDriveFile({ id: "abc", name: "ro.ssd", capabilities: { canEdit: false } }).savesChanges).toBe(
            false,
        );
        expect(describeBrowserDisc("saves.ssd")).toMatchObject({ ref: "local:saves.ssd", savesChanges: true });
        expect(describeSessionFile("3/t.uef", "t.uef", "tape")).toMatchObject({
            ref: "session:3/t.uef",
            title: "t.uef",
            kind: "tape",
            detail: "opened this session",
        });
        expect(describeSessionFile("5/t.uef", "t.uef", "tape", { order: 3, count: 4 }).detail).toBe(
            "opened this session, 3rd of 4",
        );
    });

    it("finds the discs held in the browser's storage, in order", () => {
        window.localStorage.setItem("disc_zebra.ssd", "");
        window.localStorage.setItem("disc_apple.ssd", "");
        window.localStorage.setItem("quietDiscNotSaved", "1");
        expect(browserDiscNames()).toEqual(["apple.ssd", "zebra.ssd"]);
    });

    describe("what was loaded recently", () => {
        const disc = (ref) => ({ ref, kind: "disc" });
        beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
        afterEach(() => vi.restoreAllMocks());
        const refusing = () => ({
            getItem: vi.fn(() => {
                throw new Error("SecurityError");
            }),
            setItem: vi.fn(() => {
                throw new Error("QuotaExceededError");
            }),
        });

        it("ranks the newest first, moving one loaded again to the front", () => {
            const recent = new RecentMedia();
            for (const ref of ["sth:A.zip", "sth:B.zip", "sth:A.zip"]) recent.note(ref, "disc");
            expect(recent.rank(disc("sth:A.zip"))).toBe(0);
            expect(recent.rank(disc("sth:B.zip"))).toBe(1);
            expect(recent.rank(disc("sth:C.zip"))).toBe(-1);
        });

        it("tells a tape from a disc with the same reference", () => {
            const recent = new RecentMedia();
            recent.note("sth:Both.zip", "tape");
            expect(recent.rank({ ref: "sth:Both.zip", kind: "tape" })).toBe(0);
            expect(recent.rank(disc("sth:Both.zip"))).toBe(-1);
        });

        it("keeps the eight newest", () => {
            const recent = new RecentMedia();
            for (let i = 1; i <= 9; ++i) recent.note(`sth:${i}.zip`, "disc");
            expect(recent.rank(disc("sth:9.zip"))).toBe(0);
            expect(recent.rank(disc("sth:2.zip"))).toBe(7);
            expect(recent.rank(disc("sth:1.zip"))).toBe(-1);
        });

        it("lets no number of files opened this session push out what is kept across visits", () => {
            const stored = Array.from({ length: 8 }, (_, i) => disc(`sth:${i}.zip`));
            window.localStorage.setItem("recentMedia", JSON.stringify(stored));
            const recent = new RecentMedia();
            recent.note("session:1/mine.ssd", "disc");
            expect(new RecentMedia().entries).toEqual(stored);
            for (let i = 2; i <= 9; ++i) recent.note(`session:${i}/mine.ssd`, "disc");
            expect(new RecentMedia().entries).toEqual(stored);
            expect(recent.rank(disc("session:9/mine.ssd"))).toBe(0);
            expect(recent.rank(disc("session:2/mine.ssd"))).toBe(7);
            expect(recent.rank(disc("session:1/mine.ssd"))).toBe(-1);
            expect(recent.rank(disc("sth:0.zip"))).toBe(8);
        });

        it("reads back no more than the eight newest, however many were stored", () => {
            const stored = Array.from({ length: 20 }, (_, i) => disc(`sth:${i}.zip`));
            window.localStorage.setItem("recentMedia", JSON.stringify(stored));
            expect(new RecentMedia().entries).toEqual(stored.slice(0, 8));
        });

        it("remembers across visits, but not a file opened this session, which a later visit cannot load", () => {
            const before = new RecentMedia();
            before.note("sth:A.zip", "disc");
            before.note("session:1/mine.ssd", "disc");
            expect(before.rank(disc("session:1/mine.ssd"))).toBe(0);
            const after = new RecentMedia();
            expect(after.entries).toEqual([disc("sth:A.zip")]);
        });

        it("starts empty from storage that refuses or holds something else", () => {
            expect(new RecentMedia(refusing).entries).toEqual([]);
            window.localStorage.setItem("recentMedia", "{not json");
            expect(new RecentMedia().entries).toEqual([]);
            window.localStorage.setItem("recentMedia", '{"ref":"sth:A.zip"}');
            expect(new RecentMedia().entries).toEqual([]);
        });

        it("still ranks what was loaded when storage will not keep it", () => {
            const recent = new RecentMedia(refusing);
            recent.note("sth:A.zip", "disc");
            expect(recent.rank(disc("sth:A.zip"))).toBe(0);
        });

        it("still ranks what was loaded when there is no storage at all", () => {
            const recent = new RecentMedia(() => {
                throw new Error("SecurityError");
            });
            recent.note("sth:A.zip", "disc");
            expect(recent.rank(disc("sth:A.zip"))).toBe(0);
        });
    });

    describe("ordering the list", () => {
        const sth = (path) => describeSthDisc(path);
        const hfe = (title, publisher = "Acornsoft") => describeHfeEntry({ path: `${title}.hfe`, title, publisher });
        const bitshifters = (title) =>
            describeBitshiftersEntry({ path: `${title}.ssd`, title, publisher: "Bitshifters" });
        const github = (title) =>
            describeGitHubEntry({ repo: "mattgodbolt/x", path: `${title}.ssd`, title, publisher: "Matt Godbolt" });
        const builtIn = describeBuiltIn({ name: "Welcome", desc: "The disc supplied", file: "Welcome.ssd" });

        it("puts the built-in discs first, then everything by title with the richer source first", () => {
            const rows = [
                sth("Superior/Exile.zip"),
                hfe("Elite"),
                sth("Acornsoft/Elite.zip"),
                hfe("Arcadians"),
                builtIn,
                sth("Bitshifters/Paradroid.zip"),
                bitshifters("Paradroid"),
                sth("Unreleased/Onslaught.zip"),
                github("Onslaught"),
            ];
            const ordered = rows.sort(compareForQuery("")).map((d) => `${d.source}:${d.title}`);
            expect(ordered).toEqual([
                "builtin:Welcome",
                "hfe:Arcadians",
                "hfe:Elite",
                "sth:Elite",
                "sth:Exile",
                "github:Onslaught",
                "sth:Onslaught",
                "bitshifters:Paradroid",
                "sth:Paradroid",
            ]);
        });

        it("puts the best matches first when there is a query", () => {
            const rows = [
                sth("Cheats/CHT_Exile-Mapper.zip"),
                builtIn,
                sth("Superior/Exile.zip"),
                hfe("Exile", "Superior"),
            ];
            const ordered = rows.filter((d) => matchesQuery(d, "exil")).sort(compareForQuery("exil"));
            expect(ordered.map((d) => `${d.source}:${d.title}`)).toEqual([
                "hfe:Exile",
                "sth:Exile",
                "sth:CHT_Exile-Mapper",
            ]);
        });
    });

    describe("matching a query", () => {
        const elite = describeHfeEntry({ path: "a.hfe", title: "Elite", publisher: "Acornsoft", disc: "D1S1" });

        it("wants every word somewhere in the title, publisher or detail, whatever the case", () => {
            expect(matchesQuery(elite, "")).toBe(true);
            expect(matchesQuery(elite, "ELITE")).toBe(true);
            expect(matchesQuery(elite, "acorn elite")).toBe(true);
            expect(matchesQuery(elite, "d1s1")).toBe(true);
            expect(matchesQuery(elite, "elite superior")).toBe(false);
        });

        it("ranks the title itself over a title that merely contains the words", () => {
            const exile = describeSthDisc("Superior/Exile.zip");
            const cheat = describeSthDisc("Cheats/CHT_Exile-Mapper.zip");
            const inside = describeSthDisc("Other/Texileworks.zip");
            const byPublisher = describeSthDisc("Exile/Airwolf.zip");
            const scores = ["exil", "exile"].map((q) =>
                [exile, cheat, inside, byPublisher].map((d) => scoreQuery(d, q)),
            );
            for (const [whole, word, within, elsewhere] of scores) {
                expect(whole).toBeGreaterThan(word);
                expect(word).toBeGreaterThan(within);
                expect(within).toBeGreaterThan(elsewhere);
                expect(elsewhere).toBeGreaterThan(0);
            }
            expect(scoreQuery(exile, "exile")).toBeGreaterThan(scoreQuery(exile, "exil"));
            expect(scoreQuery(exile, "")).toBe(1);
        });
    });

    describe("naming where a reference came from", () => {
        it("knows every schema the URL takes", () => {
            expect(sourceOf("sth:Games/ELITE.zip")).toBe("STH archive");
            expect(sourceOf("|Games/ELITE.zip")).toBe("STH archive");
            expect(sourceOf("hfe:3A1DAB83.hfe")).toBe("HFE archive");
            expect(sourceOf("bitshifters:bs-paradroid.ssd")).toBe("Bitshifters");
            expect(sourceOf("github:mattgodbolt/nm/ninja_music.ssd")).toBe("GitHub");
            expect(sourceOf("gd:abc/mine.ssd")).toBe("Google Drive");
            expect(sourceOf("local:mine")).toBe("this browser");
            expect(sourceOf("!mine")).toBe("this browser");
            expect(sourceOf("https://example.com/a.ssd")).toBe("the web");
            expect(sourceOf("elite.ssd")).toBe("built in");
            expect(sourceOf("session:mine.ssd")).toBe("a file opened this session");
            expect(sourceOf(undefined)).toBeNull();
        });

        it("has words for every schema a reference can take", () => {
            for (const schema of Object.keys(Schemas)) {
                const ref = schema === "" ? "x.ssd" : schema.length === 1 ? `${schema}x.ssd` : `${schema}:x.ssd`;
                expect(sourceOf(ref), schema).toBeTruthy();
            }
        });
    });
});
