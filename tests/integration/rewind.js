// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RewindUI } from "../../src/web/rewind-ui.js";
import { ReplayHistory, snapshotCycle } from "../../src/replay.js";
import { cycleCount, stateHash } from "../../src/lockstep.js";
import { Video } from "../../src/video.js";
import { keyCodes } from "../../src/keymap.js";
import { domFromIndexHtml, stubCanvases, teardownDom } from "../unit/helpers.js";
import { FileBackedXhr } from "../helpers/file-backed-xhr.js";
import { bootedTestMachine } from "./helpers.js";

const FramebufferPixels = 1024 * 768;
const FramesPerSecond = 50;
const Seconds = 3;
// A held from half way through the second second to half way through the third, over the second capture.
const KeyDownFrame = 75;
const KeyUpFrame = 125;
const RunOnSeconds = 0.3;
const HeldAt = 1;

describe("Rewind on a real machine", () => {
    beforeEach(() => {
        domFromIndexHtml("rewind-open", "rewind-panel");
        vi.stubGlobal("XMLHttpRequest", FileBackedXhr);
        Element.prototype.scrollIntoView = () => {};
        stubCanvases();
    });

    afterEach(teardownDom);

    /** A booted B that ran for a few seconds as the page runs it, capturing each frame, with A held for a second. */
    async function rewindable() {
        const machine = await bootedTestMachine("B-DFS1.2", { video: new Video(false, FramebufferPixels, () => {}) });
        const cpu = machine.processor;
        const loop = Object.assign(new EventTarget(), { hold: () => () => {}, stop: () => {} });
        const history = new ReplayHistory(cpu);
        const ui = new RewindUI({ loop, history });
        for (let frame = 1; frame <= Seconds * FramesPerSecond; frame++) {
            if (frame === KeyDownFrame) machine.keyDown(keyCodes.A);
            if (frame === KeyUpFrame) machine.keyUp(keyCodes.A);
            await machine.runFor(cpu.model.cyclesPerSecond / FramesPerSecond);
            loop.dispatchEvent(new Event("frame-capture"));
            if (frame % FramesPerSecond === 0) loop.dispatchEvent(new Event("rewind-capture"));
        }
        return { machine, cpu, history, ui, held: () => cpu.keyboardInterface.keyboardState() };
    }

    const key = (name) => document.dispatchEvent(new KeyboardEvent("keydown", { key: name, cancelable: true }));

    it("previews with the keys held then, and cancelling leaves step back able to reach the oldest snapshot", async () => {
        const { cpu, history, ui, held } = await rewindable();
        const before = { state: stateHash(cpu), held: held(), picture: cpu.video.fb32.slice() };
        ui.open();
        const heldWhenShown = [];
        vi.spyOn(cpu.video, "paint").mockImplementation(() => heldWhenShown.push(cpu.sysvia.hasAnyKeyDown()));
        ui.selectSnapshot(HeldAt);
        expect(heldWhenShown).toContain(true);
        key("Escape");
        expect({ state: stateHash(cpu), held: held(), picture: cpu.video.fb32.slice() }).toEqual(before);
        expect(cpu.sysvia.hasAnyKeyDown()).toBe(false);

        const oldest = snapshotCycle(cpu, history.snapshots()[0]);
        expect(history.stepBackTo(oldest)).toBeNull();
        expect(cycleCount(cpu)).toBe(oldest);
    });

    it("goes back to a second, which is then the newest in both rings, and steps back across the key let go there", async () => {
        const { machine, cpu, history, ui, held } = await rewindable();
        const heldNow = held();
        ui.open();
        const chosen = ui.snapshots[HeldAt];
        ui.selectSnapshot(HeldAt);
        key("Enter");
        expect(cycleCount(cpu)).toBe(snapshotCycle(cpu, chosen));
        expect(ui.rewindBuffer.peek()).toBe(chosen);
        expect(ui.frames.getAll().every((frame) => snapshotCycle(cpu, frame) <= cycleCount(cpu))).toBe(true);
        expect(held()).toEqual(heldNow);

        await machine.runFor(RunOnSeconds * cpu.model.cyclesPerSecond);
        expect(history.stepBack(false)).toBeNull();
    });
});
