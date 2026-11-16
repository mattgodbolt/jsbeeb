import { describe, expect, it } from "vitest";

import { isValidName, parsePath, sameName, wildcardMatcher } from "../../src/vdfs-names.js";

describe("VDFS names", () => {
    it.each([
        ["ELITE", true],
        ["!BOOT", true],
        ["A/B", true],
        ["INF", true],
        ["A/INFO", true],
        ["", false],
        ["ELEVENCHARS", false],
        ["A.B", false],
        ["A:B", false],
        ["A*B", false],
        ["A#B", false],
        ['A"B', false],
        ["CAFÉ", false],
        ["A B", false],
        ["A\u0001B", false],
        ["FOO/INF", false],
        ["foo/Inf", false],
        ["$", false],
        ["&", false],
        ["%", false],
        ["@", false],
        ["^", false],
    ])("%j is a name: %s", (name, valid) => {
        expect(isValidName(name)).toBe(valid);
    });

    it("matches wildcards whatever the case, with * for any run and # for any one character", () => {
        const matches = (pattern, name) => wildcardMatcher(pattern).test(name);
        expect(matches("EL*", "Elite")).toBe(true);
        expect(matches("*", "")).toBe(true);
        expect(matches("E#ITE", "ELITE")).toBe(true);
        expect(matches("E#ITE", "EITE")).toBe(false);
        expect(matches("A+B", "A+B")).toBe(true);
        expect(matches("A+B", "AAB")).toBe(false);
    });

    it("compares names whatever their case", () => {
        expect(sameName("Elite", "ELITE")).toBe(true);
        expect(sameName("Elite", "Elit")).toBe(false);
    });

    describe("a path", () => {
        it.each([
            ["GAMES.ELITE", { base: "current", parts: ["GAMES", "ELITE"] }],
            ["$.GAMES", { base: "root", parts: ["GAMES"] }],
            ["&.GAMES", { base: "root", parts: ["GAMES"] }],
            ["%.TOOL", { base: "library", parts: ["TOOL"] }],
            [":0.$.GAMES", { base: "root", parts: ["GAMES"] }],
            [":0.GAMES", { base: "current", parts: ["GAMES"] }],
            ["^.TOP", { base: "current", parts: ["^", "TOP"] }],
            ["@.TOP", { base: "current", parts: ["@", "TOP"] }],
            ["$", { base: "root", parts: [] }],
            ["%", { base: "library", parts: [] }],
            ["", { base: "current", parts: ["@"] }],
            [":0", { base: "current", parts: ["@"] }],
        ])("%j is %j", (text, expected) => {
            expect(parsePath(text)).toEqual(expected);
        });

        it.each([["A..B"], ["TOOLONGNAME1"], ["A.$.B"], ["A.%"], ["GAMES."]])("%j is a bad name", (text) => {
            expect(() => parsePath(text)).toThrow("Bad name");
        });
    });
});
