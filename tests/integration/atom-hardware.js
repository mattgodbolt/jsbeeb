import { describe, it, expect } from "vitest";
import { TestMachine } from "../../src/test-machine.js";

describe("Atom hardware", () => {
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

    describe("memory layout", () => {
        it("should have video RAM accessible at 0x8000", async () => {
            await bootAtom();
            // Write 66 to video RAM, read back. The result "66" can't come
            // from the PRINT command echo since it only contains "?#8000".
            await typeAndCapture("?#8000=66");
            const output = await typeAndCapture("PRINT ?#8000");
            expect(output).toContain("66");
        });

        it("should mirror PPIA port C at 0xB006", async () => {
            await bootAtom();
            // The 8255 decodes only A0-A1; unmirrored, &B006 would read open bus, &B0.
            await typeAndCapture("A=?#B006");
            await typeAndCapture("B=?#B002");
            const output = await typeAndCapture("PRINT A=B");
            expect(output).toContain("1");
        });
    });
});
