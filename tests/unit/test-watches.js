import { describe, expect, it } from "vitest";

import { formatWatch, WatchFormats } from "../../src/watches.js";

describe("watches", () => {
    const memory = new Uint8Array(0x10000);
    memory.set([0x34, 0x12, 0xcd, 0xab], 0x70);
    memory.set([0xff, 0x01], 0xffff - 1);
    memory[0] = 0x02;
    memory[1] = 0x03;
    const peek = (address) => memory[address];
    const format = (name) => WatchFormats.find((f) => f.name === name);

    it.each([
        ["dec", 0x70, "52"],
        ["hex", 0x70, "$34"],
        ["dec16", 0x70, "4660"],
        ["hex16", 0x70, "$1234"],
        ["dec32", 0x70, "2882343476"],
        ["hex32", 0x70, "$abcd1234"],
        ["hex", 0x80, "$00"],
        ["hex32", 0x80, "$00000000"],
    ])("shows %s at %i as %s, reading little-endian", (name, address, shown) => {
        expect(formatWatch(peek, address, format(name))).toBe(shown);
    });

    it("wraps a multi-byte value past the top of memory", () => {
        expect(formatWatch(peek, 0xfffe, format("hex32"))).toBe("$030201ff");
    });
});
