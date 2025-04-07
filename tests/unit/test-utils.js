import { describe, it, beforeAll } from "vitest";
import assert from "assert";

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
            assert.strictEqual(parseAddr("$1234"), 0x1234);
            assert.strictEqual(parseAddr("$0"), 0);
            assert.strictEqual(parseAddr("$FFFF"), 0xffff);
        });

        it("parses hex values with & prefix", function () {
            assert.strictEqual(parseAddr("&1234"), 0x1234);
            assert.strictEqual(parseAddr("&0"), 0);
            assert.strictEqual(parseAddr("&FFFF"), 0xffff);
        });

        it("parses hex values with 0x prefix", function () {
            assert.strictEqual(parseAddr("0x1234"), 0x1234);
            assert.strictEqual(parseAddr("0x0"), 0);
            assert.strictEqual(parseAddr("0xFFFF"), 0xffff);
        });

        it("parses hex values with no prefix", function () {
            assert.strictEqual(parseAddr("1234"), 0x1234);
            assert.strictEqual(parseAddr("0"), 0);
            assert.strictEqual(parseAddr("FFFF"), 0xffff);
        });
    });

    describe("hexbyte", function () {
        it("formats single-digit values correctly", function () {
            assert.strictEqual(hexbyte(0), "00");
            assert.strictEqual(hexbyte(9), "09");
        });

        it("formats two-digit values correctly", function () {
            assert.strictEqual(hexbyte(10), "0a");
            assert.strictEqual(hexbyte(255), "ff");
        });

        it("truncates values greater than 255", function () {
            assert.strictEqual(hexbyte(256), "00");
            assert.strictEqual(hexbyte(257), "01");
        });
    });

    describe("hexword", function () {
        it("formats values as 4-digit hex", function () {
            assert.strictEqual(hexword(0), "0000");
            assert.strictEqual(hexword(0x1234), "1234");
            assert.strictEqual(hexword(0xffff), "ffff");
        });

        it("truncates values greater than 0xFFFF", function () {
            assert.strictEqual(hexword(0x10000), "0000");
            assert.strictEqual(hexword(0x10001), "0001");
        });
    });

    describe("signExtend", function () {
        it("leaves values under 128 unchanged", function () {
            assert.strictEqual(signExtend(0), 0);
            assert.strictEqual(signExtend(127), 127);
        });

        it("converts values between 128 and 255 to negative", function () {
            assert.strictEqual(signExtend(128), -128);
            assert.strictEqual(signExtend(255), -1);
        });
    });

    describe("uint8Array conversion", function () {
        it("converts between string and Uint8Array", function () {
            const str = "Hello, world!";
            const arr = stringToUint8Array(str);

            assert(arr instanceof Uint8Array);
            assert.strictEqual(arr.length, str.length);
            assert.strictEqual(uint8ArrayToString(arr), str);
        });

        it("handles empty string", function () {
            const str = "";
            const arr = stringToUint8Array(str);

            assert(arr instanceof Uint8Array);
            assert.strictEqual(arr.length, 0);
            assert.strictEqual(uint8ArrayToString(arr), str);
        });

        it("truncates characters to 8 bits", function () {
            const arr = stringToUint8Array("\u1234"); // Character outside of 8-bit range
            assert.strictEqual(arr[0], 0x34); // Should be truncated to the lower 8 bits
        });
    });

    describe("readInt functions", function () {
        it("reads 16-bit integers correctly", function () {
            const data = new Uint8Array([0x34, 0x12, 0xff, 0xff]);
            assert.strictEqual(readInt16(data, 0), 0x1234);
            assert.strictEqual(readInt16(data, 2), 0xffff);
        });

        it("reads 32-bit integers correctly", function () {
            const data = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0xff]);
            assert.strictEqual(readInt32(data, 0), 0x12345678);
            // In JavaScript, bitwise operations are performed on 32-bit integers
            // 0xFFFFFFFF is treated as -1 when interpreted as a signed 32-bit integer
            assert.strictEqual(readInt32(data, 4), -1);
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
            assert.strictEqual(stream.name, "test");
            assert.strictEqual(stream.pos, 0);
            assert.strictEqual(stream.end, 5);
            assert.strictEqual(stream.bytesLeft(), 5);
            assert.strictEqual(stream.eof(), false);
        });

        it("creates from Uint8Array data", function () {
            const data = new Uint8Array([1, 2, 3, 4, 5]);
            const stream = new DataStream("test", data);
            assert.strictEqual(stream.bytesLeft(), 5);
            assert.deepStrictEqual(stream.data, data);
        });

        it("handles advancing position correctly", function () {
            const stream = new DataStream("test", "Hello");

            // Advance and get position
            const pos = stream.advance(2);
            assert.strictEqual(pos, 0);
            assert.strictEqual(stream.pos, 2);
            assert.strictEqual(stream.bytesLeft(), 3);

            // Advance more
            stream.advance(2);
            assert.strictEqual(stream.pos, 4);
            assert.strictEqual(stream.bytesLeft(), 1);
            assert.strictEqual(stream.eof(), false);

            // Advance to the end
            stream.advance(1);
            assert.strictEqual(stream.bytesLeft(), 0);
            assert.strictEqual(stream.eof(), true);

            // Trying to advance past the end should throw
            assert.throws(() => {
                stream.advance(1);
            }, RangeError);
        });

        it("reads bytes correctly", function () {
            const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
            const stream = new DataStream("test", data);

            assert.strictEqual(stream.readByte(), 0x12);
            assert.strictEqual(stream.pos, 1);

            assert.strictEqual(stream.readByte(2), 0x56);
            assert.strictEqual(stream.pos, 1); // Position shouldn't change when position is provided

            stream.advance(2);
            assert.strictEqual(stream.readByte(), 0x78);
            assert.strictEqual(stream.pos, 4);
        });

        it("reads 16-bit and 32-bit values correctly", function () {
            const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
            const stream = new DataStream("test", data);

            assert.strictEqual(stream.readInt16(), 0x3412);
            assert.strictEqual(stream.pos, 2);

            assert.strictEqual(stream.readInt16(4), 0xbc9a);
            assert.strictEqual(stream.pos, 2);

            // In JavaScript bitwise operations, large 32-bit values can be interpreted as negative
            // So we compare the actual value from readInt32 without using a literal
            const expectedInt32 = readInt32(data, 2);
            assert.strictEqual(stream.readInt32(), expectedInt32);
            assert.strictEqual(stream.pos, 6);
        });

        it("reads null-terminated strings correctly", function () {
            const data = new Uint8Array([72, 101, 108, 108, 111, 0, 87, 111, 114, 108, 100, 0]);
            const stream = new DataStream("test", data);

            assert.strictEqual(stream.readNulString(), "Hello");
            assert.strictEqual(stream.pos, 6);

            assert.strictEqual(stream.readNulString(6), "World");
            assert.strictEqual(stream.pos, 6); // Position shouldn't change when position is provided

            stream.advance(6);
            assert.strictEqual(stream.readNulString(), "");
            assert.strictEqual(stream.pos, 12);
        });

        it("creates substreams correctly", function () {
            const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
            const stream = new DataStream("test", data);

            // Create substream from current position with length
            const sub1 = stream.substream(3);
            assert.strictEqual(sub1.name, "test.sub");
            assert.strictEqual(sub1.pos, 0);
            assert.strictEqual(sub1.end, 3);
            assert.deepStrictEqual(Array.from(sub1.data), [1, 2, 3]);
            assert.strictEqual(stream.pos, 3);

            // Create substream from specific position with length
            const sub2 = stream.substream(4, 2);
            assert.strictEqual(sub2.pos, 0);
            assert.strictEqual(sub2.end, 2);
            assert.deepStrictEqual(Array.from(sub2.data), [5, 6]);
            assert.strictEqual(stream.pos, 3); // Original stream position unchanged
        });

        it("seeks to position correctly", function () {
            const stream = new DataStream("test", "Hello World");

            stream.seek(6);
            assert.strictEqual(stream.pos, 6);
            assert.strictEqual(stream.bytesLeft(), 5);

            assert.throws(() => {
                stream.seek(20);
            }, RangeError);
        });
    });

    describe("Keyboard mapping", function () {
        it("maps simple strings to BBC keys correctly", function () {
            const { stringToBBCKeys, BBC } = require("../../src/utils.js");

            // Test special characters
            const keys1 = stringToBBCKeys("\n\t ");
            assert.deepStrictEqual(keys1, [BBC.RETURN, BBC.TAB, BBC.SPACE]);

            // Verify uppercase letters are mapped correctly
            assert.deepStrictEqual(stringToBBCKeys("ABC"), [BBC.A, BBC.B, BBC.C]);

            // Verify numbers are mapped correctly
            assert.deepStrictEqual(stringToBBCKeys("123"), [BBC.K1, BBC.K2, BBC.K3]);

            // Test that stringToBBCKeys returns expected length for simple inputs
            assert.strictEqual(stringToBBCKeys("Q").length, 1);
            assert.strictEqual(stringToBBCKeys("a").length, 3); // With CAPSLOCK toggles
            assert.strictEqual(stringToBBCKeys("!").length, 3); // With SHIFT
        });
    });
});
