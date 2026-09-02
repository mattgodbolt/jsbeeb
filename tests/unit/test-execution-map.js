import { beforeEach, describe, expect, it } from "vitest";

import { ExecutionMap } from "../../src/execution-map.js";

describe("ExecutionMap", () => {
    const mem = new Uint8Array(0x10000);
    const cpu = { peekmem: (addr) => mem[addr & 0xffff], romsel: 0 };
    let map;

    beforeEach(() => {
        mem.fill(0xea);
        cpu.romsel = 0;
        map = new ExecutionMap(cpu);
    });

    it("verifies an address only once it has executed", () => {
        expect(map.isVerified(0x2000)).toBe(false);
        map.record(0x2000, mem[0x2000]);
        expect(map.isVerified(0x2000)).toBe(true);
        expect(map.isVerified(0x2001)).toBe(false);
    });

    it("distinguishes an executed 0xff opcode from never-executed", () => {
        mem[0x2000] = 0xff;
        map.record(0x2000, 0xff);
        expect(map.isVerified(0x2000)).toBe(true);
        mem[0x3000] = 0xff;
        expect(map.isVerified(0x3000)).toBe(false);
    });

    it("invalidates an entry when the byte is overwritten, and trusts it again when restored", () => {
        map.record(0x2000, mem[0x2000]);
        mem[0x2000] = 0x60;
        expect(map.isVerified(0x2000)).toBe(false);
        mem[0x2000] = 0xea;
        expect(map.isVerified(0x2000)).toBe(true);
    });

    it("keys the sideways region by the selected bank, ignoring the high romsel bits", () => {
        cpu.romsel = 4;
        map.record(0x9000, mem[0x9000]);
        expect(map.isVerified(0x9000)).toBe(true);
        cpu.romsel = 5;
        expect(map.isVerified(0x9000)).toBe(false);
        cpu.romsel = 0x84;
        expect(map.isVerified(0x9000)).toBe(true);
    });

    it("keeps main-memory entries whatever bank is paged in", () => {
        cpu.romsel = 4;
        map.record(0x2000, mem[0x2000]);
        map.record(0xd000, mem[0xd000]);
        cpu.romsel = 9;
        expect(map.isVerified(0x2000)).toBe(true);
        expect(map.isVerified(0xd000)).toBe(true);
    });
});
