import { describe, expect, it } from "vitest";

import { formatWatch, parseCondition, WatchFormats, writeStops } from "../../src/watches.js";

describe("watches", () => {
    const memory = new Uint8Array(0x10000);
    memory.set([0x34, 0x12, 0xcd, 0xab], 0x70);
    memory.set([0xff, 0x01], 0xffff - 1);
    memory[0] = 0x02;
    memory[1] = 0x03;
    const peek = (address) => memory[address];
    const format = (name) => WatchFormats.find((f) => f.name === name);
    const NoCpu = {};

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

    it.each([
        ["= 5", 5, true, "=5"],
        ["= 5", 6, false, "=5"],
        ["!= $20", 0x20, false, "!=$20"],
        ["> &7f", 0x80, true, ">$7f"],
        ["<= 0x10", 0x10, true, "<=$10"],
        ["<10", 9, true, "<10"],
        ["65", 65, true, "=65"],
        ["$41", 64, false, "=$41"],
        ["$41", 66, false, "=$41"],
        ["== 5", 5, true, "=5"],
        [">= 300", 299, false, ">=300"],
        ["<> 5", 6, true, "<>5"],
        ["> -1", 0, true, ">-1"],
        ["< A", 8, true, "<A"],
        ["= ?&70 + 1", 0x35, true, "=?&70 + 1"],
        ["= $41 OR $42", 0x43, true, "=$41 OR $42"],
        ["= $41 OR $42", 0x41, false, "=$41 OR $42"],
        ["< old", 4, true, "<old"],
        ["= PC", 0x2002, true, "=PC"],
    ])("holds a condition %s for %i: %s, shown as %s", (text, value, holds, shown) => {
        const cpu = { a: 9, peekmem: peek };
        expect(parseCondition(text)).toMatchObject({ text: shown });
        expect(parseCondition(text).holds(value, 5, cpu, 0x2002)).toBe(holds);
    });

    it.each(["= $", "= 5x", "", "=== 5", "=> 5", "is 5"])("refuses the condition %j", (text) => {
        expect(parseCondition(text)).toBeUndefined();
    });

    it.each([
        ["a write of the same value", "hex16", null, 0x70, 0x34, true, false],
        ["a write changing the low byte", "hex16", null, 0x70, 0x35, true, true],
        ["a write changing the high byte", "hex16", null, 0x71, 0x13, true, true],
        ["a write past its bytes", "hex16", null, 0x72, 0x00, true, false],
        ["a write making the condition hold", "hex16", "= $1200", 0x70, 0x00, true, true],
        ["a write leaving the condition false", "hex16", "= $1200", 0x70, 0x01, true, false],
        ["a write one more than the whole value before", "hex16", "= old + 1", 0x70, 0x35, true, true],
        ["a write two more than the whole value before", "hex16", "= old + 1", 0x70, 0x36, true, false],
        ["a device write of the same byte", "hex", null, 0x70, 0x34, false, true],
        ["a device write failing the condition", "hex", "= $05", 0x70, 0x06, false, false],
        ["a device write tested against the byte written", "hex16", "= $00", 0x71, 0x00, false, true],
    ])("decides whether %s stops a %s watch", (_, name, text, at, byte, toRam, stops) => {
        const watch = { address: 0x70, format: format(name), condition: text && parseCondition(text) };
        expect(writeStops(peek, watch, at, byte, toRam, NoCpu, 0)).toBe(stops);
    });

    it("sees a write wrapping past the top of memory into a watch", () => {
        const watch = { address: 0xffff, format: format("hex16"), condition: null };
        expect(writeStops(peek, watch, 0x0000, 0x09, true, NoCpu, 0)).toBe(true);
    });
});
