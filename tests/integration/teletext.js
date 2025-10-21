import { describe, it } from "vitest";
import { TestMachine } from "../test-machine.js";
import assert from "assert";
import { Video } from "../../src/video.js";
import sharp from "sharp";
import pixelmatch from "pixelmatch";

class CapturingVideo extends Video {
    constructor() {
        super(false, new Uint32Array(1024 * 1024), () => {});
        this.paint_ext = (left, top, right, bottom) => this._onPaint(left, top, right, bottom);
        this._capturing = false;
        this._captureSharp = null;
    }

    _onPaint(left, top, right, bottom) {
        if (this._capturing) {
            const width = right - left;
            const height = bottom - top;
            const bufferCopy = new Uint8Array(this.fb32.buffer.slice(0));
            this._captureSharp = sharp(bufferCopy, {
                raw: { width: 1024, height: 1024, channels: 4 },
            }).extract({ left: left, top: top, width, height });
            this._capturing = false;
        }
    }

    async capture(testMachine) {
        this._capturing = true;
        await testMachine.runUntilVblank();
        if (this._capturing) throw new Error("Should have captured by now");
        return this._captureSharp;
    }
}

async function setupCeefaxTestMachine(video) {
    const testMachine = new TestMachine(null, { video: video });
    await testMachine.initialise();
    await testMachine.runUntilInput();
    await testMachine.loadDisc("discs/eng_test.ssd");
    await testMachine.type("*EXEC !BOOT");
    await testMachine.runFor(3 * 1000 * 1000);
    return testMachine;
}

const rootDir = "tests/integration/teletext";
const outputDir = `tests/integration/output`;

async function compare(video, testMachine, expectedName) {
    const outputName = `${expectedName.replace("expected", "actual")}`;
    const captureSharp = await video.capture(testMachine);
    const outputFile = `${outputDir}/${outputName}`;
    await captureSharp.removeAlpha().toFile(outputFile);
    const expectedFile = `${rootDir}/${expectedName}`;
    const diffFile = `${outputDir}/${outputName.replace(".png", ".diff.png")}`;

    const { data: expectedData, info } = await sharp(expectedFile)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const actualData = await sharp(outputFile).ensureAlpha().raw().toBuffer();
    const diffData = new Uint8Array(info.width * info.height * info.channels);

    const numDiffPixels = pixelmatch(expectedData, actualData, diffData, info.width, info.height, {
        threshold: 0.1,
    });
    await sharp(diffData, { raw: info }).removeAlpha().toFile(diffFile);
    assert.equal(
        numDiffPixels,
        0,
        `Images do not match - expected ${expectedFile}, got ${outputFile}, diffs: ${diffFile}}`,
    );
}

describe("Test Ceefax test page", { timeout: 30000 }, () => {
    it("should match the Ceefax test page (no flash)", async () => {
        const video = new CapturingVideo();
        const testMachine = await setupCeefaxTestMachine(video);
        await compare(video, testMachine, `expected_flash_0.png`);
    });
    it("should match the Ceefax test page (flash)", async () => {
        const video = new CapturingVideo();
        const testMachine = await setupCeefaxTestMachine(video);
        await testMachine.runFor(1500000);
        await compare(video, testMachine, `expected_flash_1.png`);
    });
    it("should match the Ceefax test page after reveal (no flash)", async () => {
        const video = new CapturingVideo();
        const testMachine = await setupCeefaxTestMachine(video);
        await testMachine.type(" ");
        await compare(video, testMachine, `expected_reveal_flash_0.png`);
    });
    it("should match the Ceefax test page after reveal (flash)", async () => {
        const video = new CapturingVideo();
        const testMachine = await setupCeefaxTestMachine(video);
        await testMachine.type(" ");
        await testMachine.runFor(1500000);
        await compare(video, testMachine, `expected_reveal_flash_1.png`);
    });
});

describe("Test other teletext test pages", { timeout: 30000 }, () => {
    it("should work with hoglet's test case", async () => {
        const video = new CapturingVideo();
        const testMachine = new TestMachine(null, { video: video });
        await testMachine.initialise();
        await testMachine.runUntilInput();
        // https://github.com/mattgodbolt/jsbeeb/issues/316
        await testMachine.type("VDU &91,&61,&9E,&92,&93,&94,&81,&91,&91,10,13");
        await testMachine.runUntilInput();
        await compare(video, testMachine, `expected_hoglet_held_char.png`);
    });
    it("should work with the alternative engineer test page bug 469", async () => {
        const video = new CapturingVideo();
        const testMachine = new TestMachine(null, { video: video });
        await testMachine.initialise();
        await testMachine.runUntilInput();
        // https://github.com/mattgodbolt/jsbeeb/issues/469
        // Taken from the 7th line of the engineer test page from b2.
        await testMachine.type(
            "CLS:VDU &81,&80,&81,&A0,&80,&A0,&81,&9E,&A0,&9E,&A0,&97,&AC,&93,&93,&96,&96,&92,&92,&92,&95,&95,&91,&91,&94,&94,&94,&A0,&A0,&94,&80,&81,&80,&81,&80,&81,&80,&81,&B0,&B7",
        );
        await testMachine.runUntilInput();
        await compare(video, testMachine, `expected_bug_469.png`);
    });
});
