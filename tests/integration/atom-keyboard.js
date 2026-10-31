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
        machine.drainText();
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

    it("should type text with spaces in lowercase runs", async () => {
        await bootAtom();
        const output = await typeAndCapture('P."attempting to unzip"', 3000000);
        expect(output).toContain("attempting to unzip");
    });

    it("should preserve caps lock state across commands", async () => {
        await bootAtom();
        await typeAndCapture('P."hello"');
        const output = await typeAndCapture("PRINT 99");
        expect(output).toContain("PRINT 99");
        expect(output).toContain("99");
    });

    it("pastes the characters shift makes on the Atom's symbol keys, with the lock off", async () => {
        await bootAtom();
        const output = await typeAndCapture('P."a@[\\]^`{|}~"', 3000000);
        expect(output).toContain('"a@[\\]^`{|}~>');
    });

    it("moves the cursor with the host's arrows, keeping them out of the line", async () => {
        await bootAtom();
        const tap = async (code) => {
            machine.keyDown(code);
            await machine.runFor(100000);
            machine.keyUp(code);
            await machine.runFor(200000);
        };
        const cursor = () => ({
            column: machine.readbyte(0xe0),
            line: machine.readbyte(0xde) | (machine.readbyte(0xdf) << 8),
        });
        for (const code of [keyCodes.P, keyCodes.PERIOD, keyCodes.K1, keyCodes.K2]) await tap(code);

        const moves = [];
        for (const arrow of ["LEFT", "RIGHT", "UP", "DOWN"]) {
            const before = cursor();
            await tap(keyCodes[arrow]);
            const after = cursor();
            moves.push([arrow, after.column - before.column, after.line - before.line]);
        }
        expect(moves).toEqual([
            ["LEFT", -1, 0],
            ["RIGHT", 1, 0],
            ["UP", 0, -32],
            ["DOWN", 0, 32],
        ]);

        await tap(keyCodes.K3);
        await tap(keyCodes.ENTER);
        await machine.runUntilInput(10);
        const output = machine.drainText();
        expect(output).toContain("123");
        expect(output).not.toContain("ERROR");
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

        it("types the shifted brackets and bar as typed, with the lock either way", async () => {
            await bootNatural();
            await press("|", true);
            await press("{", true);
            await press(keyCodes.CAPSLOCK, false);
            await press("}", true);
            await press("a", false);
            await machine.runFor(500000);
            expect(machine.drainText()).toBe("|{}a");
        });
    });
});
