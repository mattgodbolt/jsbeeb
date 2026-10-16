import { test } from "vitest";

import { TestMachine } from "../../src/test-machine.js";
import { Video } from "../../src/video.js";

// An iteration runs one frame's worth of cycles, so the mean column Vitest prints reads as ms per frame.
const FramesPerSecond = 50;
const FbWidth = 1024;
const FbHeight = 625;
const PromptTimeoutSecs = 30;
const CharsToPrint = 2600;
const ScreenFullOfText = `FOR I%=1 TO ${CharsToPrint}:VDU 33+I% MOD 94:NEXT`;
const OsModeAddr = 0x355;
const BasicIPercentAddr = 0x424;

async function screenFullOfTextIn(mode) {
    const video = new Video(false, new Uint32Array(FbWidth * FbHeight), () => {});
    const machine = new TestMachine("B-DFS1.2", { video });
    await machine.initialise();
    await machine.runUntilInput(PromptTimeoutSecs);
    await machine.type(`MODE ${mode}:${ScreenFullOfText}`);
    await machine.runUntilInput(PromptTimeoutSecs);
    const modeSet = machine.readbyte(OsModeAddr);
    const charsPrinted = machine.readword(BasicIPercentAddr) - 1;
    if (modeSet !== mode || charsPrinted !== CharsToPrint) {
        throw new Error(
            `Setup for MODE ${mode} left MODE ${modeSet} with ${charsPrinted} of ${CharsToPrint} characters printed`,
        );
    }
    const cpu = machine.processor;
    const cyclesPerFrame = cpu.model.cyclesPerSecond / FramesPerSecond;
    return () => cpu.execute(cyclesPerFrame);
}

test("a model B at the BASIC prompt with a screen full of text", async ({ bench }) => {
    const mode0Frame = await screenFullOfTextIn(0);
    const mode7Frame = await screenFullOfTextIn(7);
    await bench.compare(bench("MODE 0 frame", mode0Frame), bench("MODE 7 frame", mode7Frame));
});
