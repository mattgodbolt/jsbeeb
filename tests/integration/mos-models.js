import { describe, expect, it, vi } from "vitest";

import { TestMachine } from "../../src/test-machine.js";
import { Video } from "../../src/video.js";
import { bootedTestMachine, mode7Text } from "./helpers.js";

const ScreenColumns = 40;
const FramebufferPixels = 1024 * 1024;

function screenLines(machine) {
    const text = mode7Text(machine);
    const lines = [];
    for (let i = 0; i < text.length; i += ScreenColumns) lines.push(text.slice(i, i + ScreenColumns).trim());
    return lines.filter((line) => line !== "");
}

describe.each([
    { model: "B-DFS1.2", startup: ["BBC Computer 32K", "Acorn DFS", "BASIC", ">"], vsyncAddress: 0xdd15 },
    { model: "B-US", startup: ["Acorn OS", "Acorn DFS", "BASIC", ">"], vsyncAddress: 0xdcec },
    { model: "B-German", startup: ["Acorn OS 32K", "Acorn DFS", "BASIC", ">"], vsyncAddress: 0xdd15 },
    { model: "B-MOS0.10", startup: ["BBC Computer 32K", "BASIC", ">"], vsyncAddress: 0xdf12 },
])("the $model MOS", ({ model, startup, vsyncAddress }) => {
    it("boots to BASIC with its own banner, runs a line and changes mode without touching a VideoNuLA", async () => {
        const onMissingVideoNula = vi.fn();
        const video = new Video(false, FramebufferPixels, () => {}, { onMissingVideoNula });
        const machine = await bootedTestMachine(model, { video }, 10);
        expect(screenLines(machine)).toEqual(startup);

        await machine.type("PRINT 6*7");
        await machine.runUntilInput(10);
        expect(screenLines(machine).slice(-2)).toEqual(["42", ">"]);

        await machine.type("MODE 2");
        await machine.runUntilInput(10);
        expect(onMissingVideoNula).not.toHaveBeenCalled();
    });

    it("stops at its vertical sync interrupt", async () => {
        const video = new Video(false, FramebufferPixels, () => {});
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

it.each(["Master", "MasterADFS"])("the %s MOS boots and changes mode without touching a VideoNuLA", async (model) => {
    const onMissingVideoNula = vi.fn();
    const video = new Video(true, FramebufferPixels, () => {}, {
        onMissingVideoNula,
    });
    const machine = await bootedTestMachine(model, { video }, 10);
    await machine.type("MODE 2");
    await machine.runUntilInput(10);
    expect(onMissingVideoNula).not.toHaveBeenCalled();
});

describe("the Master's TIME$", () => {
    it.each([
        { set: "Tue,20 Oct 2026.12:34:00", shown: "Tue,20 Oct 2026.12:34" },
        { set: "Tue,28 Dec 1999.23:58:00", shown: "Mon,28 Dec 2099.23:58" },
        { set: "Sat,15 Mar 1980.01:02:00", shown: "Fri,15 Mar 2080.01:02" },
        { from: "Sun,01 Feb 2026.12:00:00", set: "Tue,31 Mar 2026.12:00:00", shown: "Tue,31 Mar 2026.12:00" },
        { from: "Wed,15 Apr 2026.12:00:00", set: "Fri,31 Jul 2026.12:00:00", shown: "Fri,31 Jul 2026.12:00" },
        { from: "Sun,01 Feb 2026.12:00:00", set: "Tue,29 Feb 2028.12:00:00", shown: "Tue,29 Feb 2028.12:00" },
    ])("reads back $set as $shown", async ({ from, set, shown }) => {
        const machine = await bootedTestMachine("Master", undefined, 10);
        for (const time of [from, set].filter(Boolean)) {
            await machine.type(`TIME$="${time}"`);
            await machine.runUntilInput(10);
        }
        await machine.type("PRINT LEFT$(TIME$, 21)");
        await machine.runUntilInput(10);
        expect(screenLines(machine).slice(-2)).toEqual([shown, ">"]);
    });
});

it("MOS 0.10 names itself to *FX0", async () => {
    const machine = await bootedTestMachine("B-MOS0.10", undefined, 10);
    await machine.type("*FX0");
    await machine.runUntilInput(10);
    expect(screenLines(machine).slice(-2)).toEqual(["OS EPROM 0.10", ">"]);
});
