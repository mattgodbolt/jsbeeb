import { describe, it, expect } from "vitest";
import { TestMachine } from "../../src/test-machine.js";
import { keyCodes } from "../../src/keymap.js";

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

    it("reaches the prompt again after a command, so runUntilInput can wait for it", async () => {
        await bootAtom();
        await machine.type("PRINT 6*7");
        await machine.runUntilInput(10);
        expect(machine.drainText()).toContain("42");
    });

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

    describe("in the natural layout", () => {
        // What `Keyboard` passes the PPIA for a printable key: the character, and the host's shift.
        async function press(char, hostShift) {
            const keys = machine.processor.keyboardInterface;
            if (hostShift) keys.keyDown(keyCodes.SHIFT_LEFT, true);
            keys.keyDown(char, hostShift);
            await machine.runFor(100000);
            keys.keyUp(char);
            if (hostShift) keys.keyUp(keyCodes.SHIFT_LEFT);
            await machine.runFor(100000);
        }

        async function bootNatural() {
            await bootAtom();
            machine.processor.setKeyLayout("natural");
        }

        it("types what the host produced, holding the Atom's shift its own way", async () => {
            await bootNatural();
            await press("@", true);
            await press("=", false);
            await press("a", false);
            await press("a", true);
            await machine.runFor(500000);
            expect(machine.drainText()).toBe("@=Aa");
        });
    });
});
