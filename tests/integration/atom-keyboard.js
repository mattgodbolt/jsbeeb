import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";

describe("Atom keyboard", () => {
    let machine;

    async function bootAtom() {
        machine = new TestMachine("Atom");
        await machine.initialise();
        machine.startCapture();
        await machine.runUntilInput(10);
        machine.drainText(); // discard boot message
    }

    async function typeAndCapture(text, runCycles = 2000000) {
        await machine.type(text);
        await machine.runFor(runCycles);
        return machine.drainText();
    }

    it("should type uppercase text", async () => {
        await bootAtom();
        const output = await typeAndCapture("PRINT 42");
        expect(output).toContain("PRINT 42");
        expect(output).toContain("42");
    });

    it("should type mixed case text", async () => {
        await bootAtom();
        // P."Hello" should echo "Hello" then print Hello
        const output = await typeAndCapture('P."Hello"');
        expect(output).toContain("Hello");
    });

    it("should type shifted characters", async () => {
        await bootAtom();
        const output = await typeAndCapture("PRINT 1+2");
        expect(output).toContain("PRINT 1+2");
        expect(output).toContain("3");
    });

    it("should type text with spaces in lowercase runs", async () => {
        await bootAtom();
        // This reproduced the original bug: spaces in lowercase text caused
        // unnecessary LOCK toggles that the ROM read as character input.
        // "attempting to unzip" has spaces mid-lowercase — previously each
        // space triggered 2 extra LOCK presses, garbling the output.
        const output = await typeAndCapture('P."attempting to unzip"', 3000000);
        expect(output).toContain("attempting to unzip");
    });

    it("should preserve caps lock state across commands", async () => {
        await bootAtom();
        // Type something with lowercase, then an all-uppercase command.
        // The trailing LOCK in stringToATOMKeys should restore caps lock.
        await typeAndCapture('P."hello"');
        const output = await typeAndCapture("PRINT 99");
        expect(output).toContain("PRINT 99");
        expect(output).toContain("99");
    });
});
