import { describe, expect, it, vi } from "vitest";

import { TestMachine } from "../../src/test-machine.js";
import { Video } from "../../src/video.js";
import { mode7Text } from "./helpers.js";

const ScreenColumns = 40;
const FramebufferPixels = 1024 * 1024;

function screenLines(machine) {
    const text = mode7Text(machine);
    const lines = [];
    for (let i = 0; i < text.length; i += ScreenColumns) lines.push(text.slice(i, i + ScreenColumns).trim());
    return lines.filter((line) => line !== "");
}

describe.each([
    { model: "B-DFS1.2", banner: "BBC Computer 32K", vsyncAddress: 0xdd15 },
    { model: "B-US", banner: "Acorn OS", vsyncAddress: 0xdcec },
    { model: "B-German", banner: "Acorn OS 32K", vsyncAddress: 0xdd15 },
])("the $model MOS", ({ model, banner, vsyncAddress }) => {
    it("boots to BASIC with its own banner and runs a line", async () => {
        const machine = new TestMachine(model);
        await machine.initialise();
        await machine.runUntilInput(10);
        expect(screenLines(machine)).toEqual([banner, "Acorn DFS", "BASIC", ">"]);

        await machine.type("PRINT 6*7");
        await machine.runUntilInput(10);
        expect(screenLines(machine).slice(-2)).toEqual(["42", ">"]);
    });

    it("stops at its vertical sync interrupt", async () => {
        const video = new Video(false, new Uint32Array(FramebufferPixels), () => {});
        const machine = new TestMachine(model, { video });
        await machine.initialise();
        await machine.runUntilVblank();
        expect(machine.processor.pc).toBe(vsyncAddress);
    });
});

it("will not wait for the vertical sync of an OS it does not know", async () => {
    const machine = new TestMachine("Master");
    await machine.initialise();
    await expect(machine.runUntilVblank()).rejects.toThrow("BBC Master 128 (DFS)");
});

it.each(["B-DFS1.2", "B-US", "B-German", "Master", "MasterADFS"])(
    "the %s MOS boots and changes mode without touching a VideoNuLA",
    async (model) => {
        const onMissingVideoNula = vi.fn();
        const video = new Video(model.startsWith("Master"), new Uint32Array(FramebufferPixels), () => {}, {
            onMissingVideoNula,
        });
        const machine = new TestMachine(model, { video });
        await machine.initialise();
        await machine.runUntilInput(10);
        await machine.type("MODE 2");
        await machine.runUntilInput(10);
        expect(onMissingVideoNula).not.toHaveBeenCalled();
    },
);
