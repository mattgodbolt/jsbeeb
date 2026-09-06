import { describe, expect, it } from "vitest";

import { installBasic } from "../../src/basic-loader.js";

describe("installBasic", () => {
    const machine = (page = 0x19) => {
        const memory = new Uint8Array(0x10000);
        memory[0x18] = page;
        return { memory, readByte: (addr) => memory[addr], writeByte: (addr, value) => (memory[addr] = value) };
    };

    it("pokes the program in at PAGE", () => {
        const m = machine(0x19);
        installBasic("\r\x00\x0a\x0dABC", m);
        expect(m.memory[0x1900]).toBe(0x0d);
        expect(String.fromCharCode(m.memory[0x1904], m.memory[0x1905], m.memory[0x1906])).toBe("ABC");
    });

    it("sets TOP and VARTOP to just past the program", () => {
        const m = machine(0x0e);
        const program = "x".repeat(0x105);
        installBasic(program, m);
        const end = 0x0e00 + 0x105;
        expect(m.memory[0x02] | (m.memory[0x03] << 8)).toBe(end);
        expect(m.memory[0x12] | (m.memory[0x13] << 8)).toBe(end);
    });
});
