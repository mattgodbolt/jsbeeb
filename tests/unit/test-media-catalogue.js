// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    BitshiftersMachines,
    browserDiscNames,
    describeBitshiftersEntry,
    describeBrowserDisc,
    describeBuiltIn,
    describeDriveFile,
    describeHfeEntry,
    describeSessionFile,
    describeSthDisc,
    describeSthTape,
    compareForQuery,
    matchesQuery,
    modelSatisfies,
    satisfiesRequirement,
    scoreQuery,
} from "../../src/web/media-catalogue.js";
import { Provenance } from "../../src/bbcdiscs.js";
import { findModel } from "../../src/models.js";

describe("the media catalogue", () => {
    afterEach(() => {
        window.localStorage.clear();
        vi.restoreAllMocks();
    });

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

        it("carries the machine an entry needs as the URL spells it, a co-processor and all", () => {
            const requiredBy = (machine) => describeBitshiftersEntry({ path: "x.ssd", machine }).requires;
            expect(requiredBy("Master")).toBe(BitshiftersMachines.Master);
            expect(requiredBy("MasterTurbo")).toEqual({
                model: "Master",
                coProcessor: true,
                name: "BBC Master 128 with a 65C102 co-processor",
            });
            expect(requiredBy(undefined)).toBeUndefined();
        });

        it("requires nothing for a machine the table has no entry for, and says so on the console once", () => {
            const log = vi.spyOn(console, "log").mockImplementation(() => {});
            expect(describeBitshiftersEntry({ path: "x.ssd", machine: "Electron" }).requires).toBeUndefined();
            expect(describeBitshiftersEntry({ path: "y.ssd", machine: "Electron" }).requires).toBeUndefined();
            expect(log).toHaveBeenCalledTimes(1);
            expect(log).toHaveBeenCalledWith(expect.stringContaining("Electron"));
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

    describe("what a requirement is satisfied by", () => {
        const machine = (name, hasTube = false) => ({ model: findModel(name), hasTube });
        const { Master, MasterTurbo } = BitshiftersMachines;

        it("takes any Master for a Master, whichever filing system it boots", () => {
            for (const name of ["Master", "MasterADFS", "MasterANFS"]) {
                expect(modelSatisfies(Master, findModel(name))).toBe(true);
                expect(satisfiesRequirement(Master, machine(name))).toBe(true);
            }
            for (const name of ["B-DFS1.2", "B", "B1770", "B1770A"]) {
                expect(modelSatisfies(Master, findModel(name))).toBe(false);
                expect(satisfiesRequirement(Master, machine(name))).toBe(false);
            }
        });

        it("needs the co-processor as well for a Master Turbo, and a Master under it", () => {
            expect(satisfiesRequirement(MasterTurbo, machine("Master", true))).toBe(true);
            expect(satisfiesRequirement(MasterTurbo, machine("Master"))).toBe(false);
            expect(satisfiesRequirement(MasterTurbo, machine("B-DFS1.2", true))).toBe(false);
        });

        it("is not put off a plain Master by a co-processor it does not need", () => {
            expect(satisfiesRequirement(Master, machine("Master", true))).toBe(true);
        });
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
        expect(describeSessionFile("t.uef", "tape")).toMatchObject({ ref: "session:t.uef", kind: "tape" });
    });

    it("finds the discs held in the browser's storage, in order", () => {
        window.localStorage.setItem("disc_zebra.ssd", "");
        window.localStorage.setItem("disc_apple.ssd", "");
        window.localStorage.setItem("quietDiscNotSaved", "1");
        expect(browserDiscNames()).toEqual(["apple.ssd", "zebra.ssd"]);
    });

    describe("ordering the list", () => {
        const sth = (path) => describeSthDisc(path);
        const hfe = (title, publisher = "Acornsoft") => describeHfeEntry({ path: `${title}.hfe`, title, publisher });
        const bitshifters = (title) =>
            describeBitshiftersEntry({ path: `${title}.ssd`, title, publisher: "Bitshifters" });
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
            ];
            const ordered = rows.sort(compareForQuery("")).map((d) => `${d.source}:${d.title}`);
            expect(ordered).toEqual([
                "builtin:Welcome",
                "hfe:Arcadians",
                "hfe:Elite",
                "sth:Elite",
                "sth:Exile",
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
});
