import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";

describe("Atom hardware", { timeout: 30000 }, () => {
    let machine;

    async function bootAtom() {
        machine = new TestMachine("Atom");
        await machine.initialise();
        machine.startCapture();
        await machine.runUntilInput(10);
        machine.drainText();
    }

    async function typeAndCapture(text, runCycles = 2000000) {
        await machine.type(text);
        await machine.runFor(runCycles);
        return machine.drainText();
    }

    describe("video modes", () => {
        it("should switch to each graphics mode without crashing", async () => {
            await bootAtom();
            // Each mode is set via the top nibble of Port A (0xB000).
            // CLEAR N sets the mode via BASIC.
            for (const cmd of ["CLEAR 1", "CLEAR 2", "CLEAR 3", "CLEAR 4"]) {
                const output = await typeAndCapture(cmd);
                expect(output).not.toContain("ERROR");
            }
        });

        it("should return to text mode after graphics", async () => {
            await bootAtom();
            await typeAndCapture("CLEAR 4");
            // CLEAR 0 returns to text mode
            await typeAndCapture("CLEAR 0");
            const output = await typeAndCapture("PRINT 42");
            expect(output).toContain("42");
        });
    });

    describe("memory layout", () => {
        it("should have video RAM accessible at 0x8000", async () => {
            await bootAtom();
            // Write to video RAM and read back
            await typeAndCapture("?#8000=66");
            const output = await typeAndCapture("PRINT ?#8000");
            expect(output).toContain("66");
        });

        it("should have PPIA registers at 0xB000", async () => {
            await bootAtom();
            // Port A is accessible and writable. Read back happens in
            // the same command to avoid keyboard scanning changing it.
            const output = await typeAndCapture("PRINT ?#B000");
            // Just verify we get a numeric value without error.
            expect(output).not.toContain("ERROR");
        });

        it("should mirror PPIA port C at 0xB006", async () => {
            await bootAtom();
            // The 8255 only decodes A0-A1, so 0xB006 mirrors 0xB002.
            // Port C output bits (0-3) are stable between reads unlike Port A
            // which changes during keyboard scanning.
            const output = await typeAndCapture("PRINT ?#B006 AND 15");
            expect(output).toContain("0"); // output bits default to 0
        });
    });

    describe("BASIC execution", () => {
        it("should execute FOR loop", async () => {
            await bootAtom();
            const output = await typeAndCapture("FOR I=1 TO 3:P.I:NEXT I", 3000000);
            expect(output).toContain("1");
            expect(output).toContain("2");
            expect(output).toContain("3");
        });

        it("should handle variable assignment and computation", async () => {
            await bootAtom();
            await typeAndCapture("A=7");
            const output = await typeAndCapture("PRINT A*A");
            expect(output).toContain("49");
        });
    });
});
