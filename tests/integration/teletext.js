import { describe, it } from "vitest";
import path from "node:path";
import sharp from "sharp";
import { Video } from "../../src/video.js";
import { bootedTestMachine, RepoRoot } from "./helpers.js";
import { expectPngToMatch } from "./png.js";

class CapturingVideo extends Video {
    constructor() {
        super(false, 1024 * 1024, () => {});
        this.paint_ext = (left, top, right, bottom) => this._onPaint(left, top, right, bottom);
        this._capturing = false;
        this._captureSharp = null;
    }

    _onPaint(left, top, right, bottom) {
        if (this._capturing) {
            const width = right - left;
            const height = bottom - top;
            const bufferCopy = new Uint8Array(this.fb32.buffer, this.fb32.byteOffset, this.fb32.byteLength).slice();
            this._captureSharp = sharp(bufferCopy, {
                raw: { width: 1024, height: 1024, channels: 4 },
            }).extract({ left: left, top: top, width, height });
            this._capturing = false;
        }
    }

    async capture(testMachine) {
        this._capturing = true;
        // A run that stopped between a frame's paint and the OS reaching its vsync handler meets the handler first.
        for (let tries = 0; this._capturing && tries < 2; tries++) await testMachine.runUntilVblank();
        if (this._capturing) throw new Error("Should have captured by now");
        return this._captureSharp.removeAlpha().png().toBuffer();
    }
}

const RefDir = path.join(RepoRoot, "tests/integration/teletext");

const FieldCycles = 40000;
const FlashCycleFields = 64;
// The flash and cursor phases both count fields since power-on, 64 and 32 to a cycle, so a
// capture at a given field of the flash cycle is the same picture whatever ran before it.
// Which field each reference was taken at was found by capturing every field and comparing.
const FlashHiddenField = 56;
const FlashShownField = 26;
const CursorJustOnField = 15;
const CursorOnField = 8;

async function captureAtField(video, testMachine, field) {
    for (let i = 0; i < 2 * FlashCycleFields; i++) {
        const png = await video.capture(testMachine);
        if (Math.floor(testMachine.elapsedCycles / FieldCycles) % FlashCycleFields === field) return png;
    }
    throw new Error(`Field ${field} did not come round`);
}

async function compare(video, testMachine, expectedName, field) {
    const actualPng = await captureAtField(video, testMachine, field);
    const outputStem = expectedName.replace("expected", "actual").replace(".png", "");
    await expectPngToMatch(actualPng, path.join(RefDir, expectedName), outputStem);
}

describe("Test Ceefax test page", () => {
    it("should match the Ceefax test page with flash hidden and shown, before and after reveal", async () => {
        const video = new CapturingVideo();
        const testMachine = await bootedTestMachine(undefined, { video });
        await testMachine.loadDisc("discs/eng_test.ssd");
        await testMachine.type("*EXEC !BOOT");
        // The drive has to spin up before the page can load, and the load takes a second or so.
        await testMachine.runFor(4 * 1000 * 1000);
        await compare(video, testMachine, `expected_flash_1.png`, FlashShownField);
        await compare(video, testMachine, `expected_flash_0.png`, FlashHiddenField);
        await testMachine.type(" ");
        await compare(video, testMachine, `expected_reveal_flash_1.png`, FlashShownField);
        await compare(video, testMachine, `expected_reveal_flash_0.png`, FlashHiddenField);
    });
});

describe("Test other teletext test pages", () => {
    it("should work with hoglet's test case", async () => {
        const video = new CapturingVideo();
        const testMachine = await bootedTestMachine(undefined, { video });
        // https://github.com/mattgodbolt/jsbeeb/issues/316
        await testMachine.type("VDU &91,&61,&9E,&92,&93,&94,&81,&91,&91,10,13");
        await testMachine.runUntilInput();
        await compare(video, testMachine, `expected_hoglet_held_char.png`, CursorJustOnField);
    });
    it("should apply Steady as Set At, not Set After (bug 611)", async () => {
        const video = new CapturingVideo();
        const testMachine = await bootedTestMachine(undefined, { video });
        // https://github.com/mattgodbolt/jsbeeb/issues/611
        // Red graphics, Flash, two blocks, Hold, Steady, two blocks: with the flash hidden, the held
        // block in the Steady cell shows, as Steady is Set At.
        await testMachine.type("CLS:VDU &91,&88,&BF,&BF,&9E,&89,&BF,&BF");
        await testMachine.runUntilInput();
        await compare(video, testMachine, `expected_steady_set_at_flash_0.png`, FlashHiddenField);
    });
    it("should work with the alternative engineer test page bug 469", async () => {
        const video = new CapturingVideo();
        const testMachine = await bootedTestMachine(undefined, { video });
        // https://github.com/mattgodbolt/jsbeeb/issues/469
        // Taken from the 7th line of the engineer test page from b2.
        await testMachine.type(
            "CLS:VDU &81,&80,&81,&A0,&80,&A0,&81,&9E,&A0,&9E,&A0,&97,&AC,&93,&93,&96,&96,&92,&92,&92,&95,&95,&91,&91,&94,&94,&94,&A0,&A0,&94,&80,&81,&80,&81,&80,&81,&80,&81,&B0,&B7",
        );
        await testMachine.runUntilInput();
        await compare(video, testMachine, `expected_bug_469.png`, CursorOnField);
    });
});
