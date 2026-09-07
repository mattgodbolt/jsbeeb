// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
    Sources,
    browserDiscNames,
    describeBrowserDisc,
    describeBuiltIn,
    describeDriveFile,
    describeHfeEntry,
    describeSessionFile,
    describeSthDisc,
    describeSthTape,
    matchesQuery,
} from "../../src/web/media-catalogue.js";
import { Provenance } from "../../src/bbcdiscs.js";

describe("the media catalogue", () => {
    afterEach(() => window.localStorage.clear());

    it("names every source the descriptors can come from", () => {
        expect(Object.keys(Sources)).toEqual(["builtin", "sth", "hfe", "gdrive", "browser", "session"]);
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
                tracks: "40",
                sides: 2,
                provenance: Provenance.Captured,
                savesChanges: false,
            });
        });

        it("leaves the pitch and sides unknown for a reconstructed disc", () => {
            const described = describeHfeEntry({ path: "x.hfe", title: "X", provenance: Provenance.Reconstructed });
            expect(described.tracks).toBeUndefined();
            expect(described.sides).toBeUndefined();
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

    describe("matching a query", () => {
        const elite = describeHfeEntry({ path: "a.hfe", title: "Elite", publisher: "Acornsoft", disc: "D1S1" });

        it("wants every word somewhere in the title, publisher or detail, whatever the case", () => {
            expect(matchesQuery(elite, "")).toBe(true);
            expect(matchesQuery(elite, "ELITE")).toBe(true);
            expect(matchesQuery(elite, "acorn elite")).toBe(true);
            expect(matchesQuery(elite, "d1s1")).toBe(true);
            expect(matchesQuery(elite, "elite superior")).toBe(false);
        });
    });
});
