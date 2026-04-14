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
        it("should switch to each 2-colour graphics mode without crashing", async () => {
            await bootAtom();
            // CLEAR N covers 2-colour modes: CLEAR 1 → 0x30, CLEAR 2 → 0x70,
            // CLEAR 3 → 0xB0, CLEAR 4 → 0xF0.
            for (const cmd of ["CLEAR 1", "CLEAR 2", "CLEAR 3", "CLEAR 4"]) {
                const output = await typeAndCapture(cmd);
                expect(output).not.toContain("ERROR");
            }
        });

        it("should switch to each 4-colour graphics mode via POKE", async () => {
            await bootAtom();
            // 4-colour modes (0x10, 0x50, 0x90, 0xD0) aren't reachable via
            // CLEAR and must be set by writing to Port A directly.
            for (const mode of ["#10", "#50", "#90", "#D0"]) {
                const output = await typeAndCapture(`?#B000=${mode}`);
                expect(output).not.toContain("ERROR");
            }
        });

        it("should return to text mode after graphics", async () => {
            await bootAtom();
            await typeAndCapture("CLEAR 4");
            // CLEAR 0 returns to text mode. Use a computed value (6*7=42)
            // so the result can't come from input echo alone.
            await typeAndCapture("CLEAR 0");
            const output = await typeAndCapture("PRINT 6*7");
            expect(output).toContain("42");
        });
    });

    describe("memory layout", () => {
        it("should have video RAM accessible at 0x8000", async () => {
            await bootAtom();
            // Write 66 to video RAM, read back. The result "66" can't come
            // from the PRINT command echo since it only contains "?#8000".
            await typeAndCapture("?#8000=66");
            const output = await typeAndCapture("PRINT ?#8000");
            expect(output).toContain("66");
        });

        it("should have PPIA registers at 0xB000", async () => {
            await bootAtom();
            const output = await typeAndCapture("PRINT ?#B000");
            expect(output).not.toContain("ERROR");
        });

        it("should mirror PPIA port C at 0xB006", async () => {
            await bootAtom();
            // The 8255 only decodes A0-A1, so 0xB006 mirrors 0xB002.
            // Verify via computed comparison: if mirroring works, the
            // two reads return the same value (result=1, BASIC true).
            // If broken, 0xB006 returns open bus (0xB0) ≠ port C value.
            await typeAndCapture("A=?#B006");
            await typeAndCapture("B=?#B002");
            const output = await typeAndCapture("PRINT A=B");
            expect(output).toContain("1");
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
