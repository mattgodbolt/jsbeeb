import { describe, expect, it } from "vitest";

describe("toEqual on typed arrays", () => {
    it.each([
        ["the same values", new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]), true],
        ["no values", new Uint8Array(0), new Uint8Array(0), true],
        ["one differing value", new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]), false],
        ["a differing last value", new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]), false],
        ["a differing length", new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]), false],
        ["NaN against NaN", new Float32Array([NaN]), new Float32Array([NaN]), true],
        ["0 against -0", new Float32Array([0]), new Float32Array([-0]), false],
        ["different element types", new Uint8Array([1]), new Int8Array([1]), false],
        ["a typed array against a plain one", new Uint8Array([1]), [1], false],
    ])("%s", (_name, received, expected, equal) => {
        if (equal) {
            expect({ nested: received }).toEqual({ nested: expected });
            expect(received).toStrictEqual(expected);
        } else {
            expect({ nested: received }).not.toEqual({ nested: expected });
            expect(received).not.toStrictEqual(expected);
        }
    });
});
