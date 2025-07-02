import { describe, it, beforeAll, expect } from "vitest";

import {
    parseAddr,
    hexbyte,
    hexword,
    signExtend,
    readInt16,
    readInt32,
    stringToUint8Array,
    uint8ArrayToString,
} from "../../src/utils.js";

describe("Utils tests", function () {
    "use strict";

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

    describe("signExtend", function () {
        it("leaves values under 128 unchanged", function () {
            expect(signExtend(0)).toBe(0);
            expect(signExtend(127)).toBe(127);
        });

        it("converts values between 128 and 255 to negative", function () {
            expect(signExtend(128)).toBe(-128);
            expect(signExtend(255)).toBe(-1);
        });
    });

    describe("uint8Array conversion", function () {
        it("converts between string and Uint8Array", function () {
            const str = "Hello, world!";
            const arr = stringToUint8Array(str);

            expect(arr).toBeInstanceOf(Uint8Array);
            expect(arr.length).toBe(str.length);
            expect(uint8ArrayToString(arr)).toBe(str);
        });

        it("handles empty string", function () {
            const str = "";
            const arr = stringToUint8Array(str);

            expect(arr).toBeInstanceOf(Uint8Array);
            expect(arr.length).toBe(0);
            expect(uint8ArrayToString(arr)).toBe(str);
        });

        it("truncates characters to 8 bits", function () {
            const arr = stringToUint8Array("\u1234"); // Character outside of 8-bit range
            expect(arr[0]).toBe(0x34); // Should be truncated to the lower 8 bits
        });
    });

    describe("readInt functions", function () {
        it("reads 16-bit integers correctly", function () {
            const data = new Uint8Array([0x34, 0x12, 0xff, 0xff]);
            expect(readInt16(data, 0)).toBe(0x1234);
            expect(readInt16(data, 2)).toBe(0xffff);
        });

        it("reads 32-bit integers correctly", function () {
            const data = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0xff]);
            expect(readInt32(data, 0)).toBe(0x12345678);
            // In JavaScript, bitwise operations are performed on 32-bit integers
            // 0xFFFFFFFF is treated as -1 when interpreted as a signed 32-bit integer
            expect(readInt32(data, 4)).toBe(-1);
        });
    });

    describe("DataStream", function () {
        let DataStream;

        beforeAll(async function () {
            const utils = await import("../../src/utils.js");
            DataStream = utils.DataStream;
        });

        it("creates from string data", function () {
            const stream = new DataStream("test", "Hello");
            expect(stream.name).toBe("test");
            expect(stream.pos).toBe(0);
            expect(stream.end).toBe(5);
            expect(stream.bytesLeft()).toBe(5);
            expect(stream.eof()).toBe(false);
        });

        it("creates from Uint8Array data", function () {
            const data = new Uint8Array([1, 2, 3, 4, 5]);
            const stream = new DataStream("test", data);
            expect(stream.bytesLeft()).toBe(5);
            expect(stream.data).toEqual(data);
        });

        it("handles advancing position correctly", function () {
            const stream = new DataStream("test", "Hello");

            // Advance and get position
            const pos = stream.advance(2);
            expect(pos).toBe(0);
            expect(stream.pos).toBe(2);
            expect(stream.bytesLeft()).toBe(3);

            // Advance more
            stream.advance(2);
            expect(stream.pos).toBe(4);
            expect(stream.bytesLeft()).toBe(1);
            expect(stream.eof()).toBe(false);

            // Advance to the end
            stream.advance(1);
            expect(stream.bytesLeft()).toBe(0);
            expect(stream.eof()).toBe(true);

            // Trying to advance past the end should throw
            expect(() => {
                stream.advance(1);
            }).toThrow(RangeError);
        });

        it("reads bytes correctly", function () {
            const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
            const stream = new DataStream("test", data);

            expect(stream.readByte()).toBe(0x12);
            expect(stream.pos).toBe(1);

            expect(stream.readByte(2)).toBe(0x56);
            expect(stream.pos).toBe(1); // Position shouldn't change when position is provided

            stream.advance(2);
            expect(stream.readByte()).toBe(0x78);
            expect(stream.pos).toBe(4);
        });

        it("reads 16-bit and 32-bit values correctly", function () {
            const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
            const stream = new DataStream("test", data);

            expect(stream.readInt16()).toBe(0x3412);
            expect(stream.pos).toBe(2);

            expect(stream.readInt16(4)).toBe(0xbc9a);
            expect(stream.pos).toBe(2);

            // In JavaScript bitwise operations, large 32-bit values can be interpreted as negative
            // So we compare the actual value from readInt32 without using a literal
            const expectedInt32 = readInt32(data, 2);
            expect(stream.readInt32()).toBe(expectedInt32);
            expect(stream.pos).toBe(6);
        });

        it("reads null-terminated strings correctly", function () {
            const data = new Uint8Array([72, 101, 108, 108, 111, 0, 87, 111, 114, 108, 100, 0]);
            const stream = new DataStream("test", data);

            expect(stream.readNulString()).toBe("Hello");
            expect(stream.pos).toBe(6);

            expect(stream.readNulString(6)).toBe("World");
            expect(stream.pos).toBe(6); // Position shouldn't change when position is provided

            stream.advance(6);
            expect(stream.readNulString()).toBe("");
            expect(stream.pos).toBe(12);
        });

        it("creates substreams correctly", function () {
            const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
            const stream = new DataStream("test", data);

            // Create substream from current position with length
            const sub1 = stream.substream(3);
            expect(sub1.name).toBe("test.sub");
            expect(sub1.pos).toBe(0);
            expect(sub1.end).toBe(3);
            expect(Array.from(sub1.data)).toEqual([1, 2, 3]);
            expect(stream.pos).toBe(3);

            // Create substream from specific position with length
            const sub2 = stream.substream(4, 2);
            expect(sub2.pos).toBe(0);
            expect(sub2.end).toBe(2);
            expect(Array.from(sub2.data)).toEqual([5, 6]);
            expect(stream.pos).toBe(3); // Original stream position unchanged
        });

        it("seeks to position correctly", function () {
            const stream = new DataStream("test", "Hello World");

            stream.seek(6);
            expect(stream.pos).toBe(6);
            expect(stream.bytesLeft()).toBe(5);

            expect(() => {
                stream.seek(20);
            }).toThrow(RangeError);
        });
    });

    describe("Keyboard mapping", function () {
        it("maps simple strings to BBC keys correctly", async function () {
            const { stringToBBCKeys, BBC } = await import("../../src/utils.js");

            // Test special characters
            const keys1 = stringToBBCKeys("\n\t ");
            expect(keys1).toEqual([BBC.RETURN, BBC.TAB, BBC.SPACE]);

            // Verify uppercase letters are mapped correctly
            expect(stringToBBCKeys("ABC")).toEqual([BBC.A, BBC.B, BBC.C]);

            // Verify numbers are mapped correctly
            expect(stringToBBCKeys("123")).toEqual([BBC.K1, BBC.K2, BBC.K3]);

            // Test that stringToBBCKeys returns expected length for simple inputs
            expect(stringToBBCKeys("Q").length).toBe(1);
            expect(stringToBBCKeys("a").length).toBe(3); // With CAPSLOCK toggles
            expect(stringToBBCKeys("!").length).toBe(3); // With SHIFT
        });
    });
});
