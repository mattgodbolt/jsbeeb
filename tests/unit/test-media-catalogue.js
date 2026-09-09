// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
    browserDiscNames,
    describeBrowserDisc,
    describeBuiltIn,
    describeDriveFile,
    describeHfeEntry,
    describeSessionFile,
    describeSthDisc,
    describeSthTape,
    compareForQuery,
    matchesQuery,
    scoreQuery,
} from "../../src/web/media-catalogue.js";
import { Provenance } from "../../src/bbcdiscs.js";

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
        const builtIn = describeBuiltIn({ name: "Welcome", desc: "The disc supplied", file: "Welcome.ssd" });

        it("puts the built-in discs first, then everything by title with the richer source first", () => {
            const rows = [
                sth("Superior/Exile.zip"),
                hfe("Elite"),
                sth("Acornsoft/Elite.zip"),
                hfe("Arcadians"),
                builtIn,
            ];
            const ordered = rows.sort(compareForQuery("")).map((d) => `${d.source}:${d.title}`);
            expect(ordered).toEqual(["builtin:Welcome", "hfe:Arcadians", "hfe:Elite", "sth:Elite", "sth:Exile"]);
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
