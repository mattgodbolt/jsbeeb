import { describe, it, expect } from "vitest";
import { fake6502, fake65C12 } from "../../src/fake6502.js";

/**
 * Tests for 6502 stack pointer behavior during reset.
 *
 * The real 6502 reset sequence is 7 cycles and reuses the interrupt/BRK
 * logic internally. During this sequence, 3 "dummy" stack operations occur
 * where SP decrements but R/W is held in read mode (no actual writes).
 * This was a hardware optimization to share logic with BRK/IRQ handling.
 *
 * Result: SP decrements 3 times during reset: 0x00 -> 0xFF -> 0xFE -> 0xFD
 *
 * References:
 * - https://www.nesdev.org/wiki/CPU_power_up_state
 * - https://www.pagetable.com/?p=410
 */

describe("6502 reset SP behavior", () => {
    it("should decrement SP by 3 during reset (NMOS 6502)", async () => {
        const cpu = fake6502();
        await cpu.initialise();
        // Real 6502 does 3 dummy pushes: 0x00 -> 0xFF -> 0xFE -> 0xFD
        expect(cpu.s).toBe(0xfd);
    });

    it("should decrement SP by 3 during reset (CMOS 65C12)", async () => {
        const cpu = fake65C12();
        await cpu.initialise();
        expect(cpu.s).toBe(0xfd);
    });

    it("should decrement SP by 3 after explicit hard reset", async () => {
        const cpu = fake6502();
        await cpu.initialise();
        cpu.s = 0x80;
        // Reset should decrement by 3: 0x80 -> 0x7F -> 0x7E -> 0x7D
        cpu.reset(true);
        expect(cpu.s).toBe(0x7d);
    });

    it("should decrement SP by 3 after explicit soft reset", async () => {
        const cpu = fake6502();
        await cpu.initialise();
        cpu.s = 0x80;
        // Soft reset should also decrement by 3
        cpu.reset(false);
        expect(cpu.s).toBe(0x7d);
    });

    it("should wrap SP correctly when decrementing near zero", async () => {
        const cpu = fake6502();
        await cpu.initialise();
        cpu.s = 0x01;
        // 0x01 -> 0x00 -> 0xFF -> 0xFE
        cpu.reset(true);
        expect(cpu.s).toBe(0xfe);
    });
});
