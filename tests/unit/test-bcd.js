import { describe, it, expect } from "vitest";

import { fake65C12 } from "../../src/fake6502.js";

const cpu = fake65C12();

describe("BCD tests", function () {
    "use strict";
    it("handles 65c12sbc1", async function () {
        await cpu.initialise();
        cpu.p.reset();
        cpu.p.d = true;
        cpu.a = 0x90;
        cpu.sbc(0x0b);
        expect(cpu.p.v).toBe(false);
        expect(cpu.p.c).toBe(true);
        expect(cpu.a).toBe(126);
    });

    it("handles 65c12sbc2", async function () {
        await cpu.initialise();
        cpu.p.reset();
        cpu.p.d = true;
        cpu.a = 0x80;
        cpu.sbc(0x01);
        expect(cpu.p.v).toBe(true);
        expect(cpu.p.c).toBe(true);
        expect(cpu.a).toBe(120);
    });
});
