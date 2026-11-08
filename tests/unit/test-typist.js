import { describe, expect, it } from "vitest";

import { Typist } from "../../src/typist.js";
import { BBC } from "../../src/keymap.js";
import { ATOM } from "../../src/keymap-atom.js";
import { fakeKeyboardProcessor } from "../helpers/fake-keyboard-processor.js";

function typistFor(modelName) {
    const processor = fakeKeyboardProcessor(modelName);
    const { model, keyboardInterface: keyboard } = processor;
    keyboard.capsLockLight = true;
    const typist = new Typist(processor);
    const fire = () => processor.runInstruction(1);
    const tick = (ms) => processor.runInstruction((ms * processor.peripheralCyclesPerSecond) / 1000);
    const toggles = () => keyboard.keyToggleRaw.mock.calls.map(([key]) => key);
    const finish = () => {
        for (let ticks = 0; typist.isTyping && ticks < 100; ++ticks) tick(model.pasteKeyDelayMs);
        expect(typist.isTyping).toBe(false);
    };
    return { typist, processor, keyboard, fire, tick, toggles, finish, model };
}

describe("Typist", () => {
    describe("on a BBC", () => {
        it("presses a key on one tick and releases it on the next, then gives the keyboard back", () => {
            const { typist, keyboard, fire, tick, toggles } = typistFor("B-DFS1.2");
            typist.type([BBC.A], false);
            expect(keyboard.disableKeyboard).toHaveBeenCalled();
            fire();
            expect(toggles()).toEqual([BBC.A]);
            expect(typist.isTyping).toBe(true);
            tick(50);
            expect(toggles()).toEqual([BBC.A, BBC.A]);
            expect(keyboard.enableKeyboard).toHaveBeenCalled();
            expect(typist.isTyping).toBe(false);
        });

        it("holds SHIFT across the keys that need it", () => {
            const { typist, toggles, finish } = typistFor("B-DFS1.2");
            typist.type([BBC.SHIFT, BBC.K1, BBC.SHIFT], false);
            finish();
            expect(toggles()).toEqual([BBC.SHIFT, BBC.K1, BBC.K1, BBC.SHIFT]);
        });

        it("waits out a number instead of pressing it", () => {
            const { typist, fire, tick, toggles } = typistFor("B-DFS1.2");
            typist.type([1000, BBC.A], false);
            fire();
            expect(toggles()).toEqual([]);
            expect(typist.isTyping).toBe(true);
            tick(1000);
            expect(toggles()).toEqual([BBC.A]);
        });

        it("leaves a gap between two presses of the same key", () => {
            const { typist, fire, tick, toggles } = typistFor("B-DFS1.2");
            typist.type([BBC.A, BBC.A], false);
            fire();
            tick(50);
            expect(toggles()).toEqual([BBC.A, BBC.A]);
            tick(30);
            expect(toggles()).toEqual([BBC.A, BBC.A, BBC.A]);
        });

        it("brackets the keys with CAPS LOCK when the light says lower case", () => {
            const { typist, keyboard, toggles, finish } = typistFor("B-DFS1.2");
            keyboard.capsLockLight = false;
            typist.type([BBC.A], true);
            finish();
            expect(toggles()).toEqual([BBC.CAPSLOCK, BBC.CAPSLOCK, BBC.A, BBC.A, BBC.CAPSLOCK, BBC.CAPSLOCK]);
        });

        it("brackets them with SHIFT LOCK when that light is on", () => {
            const { typist, keyboard, toggles, finish } = typistFor("B-DFS1.2");
            keyboard.shiftLockLight = true;
            typist.type([BBC.A], true);
            finish();
            expect(toggles()[0]).toBe(BBC.SHIFTLOCK);
            expect(toggles().at(-1)).toBe(BBC.SHIFTLOCK);
        });

        it("leaves the locks alone when the lights are right", () => {
            const { typist, toggles, finish } = typistFor("B-DFS1.2");
            typist.type([BBC.A], true);
            finish();
            expect(toggles()).toEqual([BBC.A, BBC.A]);
        });

        it("cancelling releases the key in flight and gives the keyboard back", () => {
            const { typist, keyboard, fire, toggles } = typistFor("B-DFS1.2");
            typist.type([BBC.A, BBC.B, BBC.C], false);
            fire();
            typist.cancel();
            expect(toggles()).toEqual([BBC.A, BBC.A]);
            expect(keyboard.enableKeyboard).toHaveBeenCalled();
            expect(typist.isTyping).toBe(false);
        });

        it("typing again replaces what was in flight", () => {
            const { typist, fire, toggles } = typistFor("B-DFS1.2");
            typist.type([BBC.A, BBC.B, BBC.C], false);
            fire();
            typist.type([BBC.X], false);
            fire();
            expect(toggles()).toEqual([BBC.A, BBC.A, BBC.X]);
        });
    });

    describe("between instructions", () => {
        it("holds one instruction hook while there is text to type, and leaves the fast path after", () => {
            const { typist, processor, finish } = typistFor("B-DFS1.2");
            expect(processor.debugInstruction.attached).toBe(0);
            typist.type([BBC.A, BBC.B], false);
            expect(processor.debugInstruction.attached).toBe(1);
            finish();
            expect(processor.debugInstruction.attached).toBe(0);
            typist.type([BBC.A], false);
            typist.cancel();
            expect(processor.debugInstruction.attached).toBe(0);
        });

        it("does not change a key before its delay is up, and waits in emulated time", () => {
            const { typist, processor, toggles } = typistFor("B-DFS1.2");
            typist.type([BBC.A], false);
            const gap = (processor.model.pasteReleaseGapMs * processor.peripheralCyclesPerSecond) / 1000;
            processor.runInstruction(gap - 1);
            expect(toggles()).toEqual([]);
            processor.runInstruction(1);
            expect(toggles()).toEqual([BBC.A]);
        });

        it.each([
            ["the scheduler's epoch not moved back", false],
            ["the scheduler's epoch moved back", true],
        ])(
            "drops the text left to type, and gives the keyboard back, once a snapshot has been restored or the machine reset: %s",
            (_, wentBack) => {
                const { typist, processor, keyboard, fire, tick, toggles } = typistFor("B-DFS1.2");
                typist.type([BBC.A, BBC.B], false);
                fire();
                const pressed = toggles().length;
                keyboard.enableKeyboard.mockClear();
                ++processor.resetsAndLoads;
                if (wentBack) processor.scheduler.restoreState({ epoch: 0 });
                tick(1000);
                expect(typist.isTyping).toBe(false);
                expect(keyboard.enableKeyboard).toHaveBeenCalled();
                expect(toggles()).toHaveLength(pressed);
                expect(processor.debugInstruction.attached).toBe(0);
            },
        );

        it("does not release a key when cancelled after a restore", () => {
            const { typist, processor, fire, toggles } = typistFor("B-DFS1.2");
            typist.type([BBC.A, BBC.B], false);
            fire();
            ++processor.resetsAndLoads;
            typist.cancel();
            expect(toggles()).toEqual([BBC.A]);
        });
    });

    describe("on an Atom", () => {
        it("leaves a gap after each release for the polled keyboard, and before the first press", () => {
            const { typist, tick, toggles } = typistFor("Atom");
            typist.type([ATOM.A, ATOM.B], false);
            tick(39);
            expect(toggles()).toEqual([]);
            tick(1);
            expect(toggles()).toEqual([ATOM.A]);
            tick(80);
            expect(toggles()).toEqual([ATOM.A, ATOM.A]);
            tick(40);
            expect(toggles()).toEqual([ATOM.A, ATOM.A, ATOM.B]);
        });

        it("does not gap after SHIFT, which stays held", () => {
            const { typist, tick, toggles } = typistFor("Atom");
            typist.type([ATOM.SHIFT, ATOM.A], false);
            tick(40);
            tick(80);
            expect(toggles()).toEqual([ATOM.SHIFT, ATOM.A]);
        });

        it("treats LOCK as a key like any other", () => {
            const { typist, tick, toggles } = typistFor("Atom");
            typist.type([ATOM.LOCK, ATOM.A, ATOM.LOCK], false);
            tick(40);
            tick(80);
            expect(toggles()).toEqual([ATOM.LOCK, ATOM.LOCK]);
            tick(40);
            expect(toggles()).toEqual([ATOM.LOCK, ATOM.LOCK, ATOM.A]);
        });

        it("presses a repeated key again after its gap", () => {
            const { typist, tick, toggles } = typistFor("Atom");
            typist.type([ATOM.A, ATOM.A], false);
            tick(40);
            tick(80);
            tick(40);
            expect(toggles()).toEqual([ATOM.A, ATOM.A, ATOM.A]);
        });
    });
});
