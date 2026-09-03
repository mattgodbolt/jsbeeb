import { describe, expect, it } from "vitest";

import { hexbyte, hexword, parseAddr } from "../../src/hex.js";

describe("hex", () => {
    describe("parseAddr", function () {
        it("parses hex values with $ prefix", function () {
            expect(parseAddr("$1234")).toBe(0x1234);
            expect(parseAddr("$0")).toBe(0);
            expect(parseAddr("$FFFF")).toBe(0xffff);
        });

        it("parses hex values with & prefix", function () {
            expect(parseAddr("&1234")).toBe(0x1234);
            expect(parseAddr("&0")).toBe(0);
            expect(parseAddr("&FFFF")).toBe(0xffff);
        });

        it("parses hex values with 0x prefix", function () {
            expect(parseAddr("0x1234")).toBe(0x1234);
            expect(parseAddr("0x0")).toBe(0);
            expect(parseAddr("0xFFFF")).toBe(0xffff);
        });

        it("parses hex values with no prefix", function () {
            expect(parseAddr("1234")).toBe(0x1234);
            expect(parseAddr("0")).toBe(0);
            expect(parseAddr("FFFF")).toBe(0xffff);
        });
    });

    describe("hexbyte", function () {
        it("formats single-digit values correctly", function () {
            expect(hexbyte(0)).toBe("00");
            expect(hexbyte(9)).toBe("09");
        });

        it("formats two-digit values correctly", function () {
            expect(hexbyte(10)).toBe("0a");
            expect(hexbyte(255)).toBe("ff");
        });

        it("truncates values greater than 255", function () {
            expect(hexbyte(256)).toBe("00");
            expect(hexbyte(257)).toBe("01");
        });
    });

    describe("hexword", function () {
        it("formats values as 4-digit hex", function () {
            expect(hexword(0)).toBe("0000");
            expect(hexword(0x1234)).toBe("1234");
            expect(hexword(0xffff)).toBe("ffff");
        });

        it("truncates values greater than 0xFFFF", function () {
            expect(hexword(0x10000)).toBe("0000");
            expect(hexword(0x10001)).toBe("0001");
        });
    });
});
