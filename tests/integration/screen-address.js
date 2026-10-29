import { describe, expect, it } from "vitest";
import { TestMachine } from "../../src/test-machine.js";
import { FakeVideo, Video } from "../../src/video.js";

const FbWidth = 1024;
const FbHeight = 625;
// Three fields: both of an interlaced picture, whatever field the run starts in.
const PictureCycles = 120000;
const ScreenBase = [0x3000, 0x3000, 0x3000, 0x4000, 0x5800, 0x5800, 0x6000, 0x7c00];
const SamplesPerMode = 9;
const Teletext = 7;
const TeletextBlank = 0x20;
const TeletextW = 0x57;
// White on black in every bitmap mode: in MODE 2 both pixels are colour 7, not flashing 15.
const LitByte = (mode) => (mode === 2 ? 0x3f : 0xff);

class FrameCapturingVideo extends Video {
    constructor(isMaster) {
        super(isMaster, FbWidth * FbHeight, () => {});
        this.frame = this.fb32.slice();
        this.paint_ext = () => (this.frame = this.fb32.slice());
    }
}

/** The bounding box of the pixels that differ between two frames, or null if none do. */
function changedBox(before, after) {
    let box = null;
    for (let y = 0; y < FbHeight; ++y) {
        for (let x = 0; x < FbWidth; ++x) {
            if (before[y * FbWidth + x] === after[y * FbWidth + x]) continue;
            box ??= { left: x, top: y, right: x, bottom: y };
            box.left = Math.min(box.left, x);
            box.right = Math.max(box.right, x);
            box.bottom = y;
        }
    }
    return box;
}

/** What a click on framebuffer pixel (x, y) finds. */
function addressAtPixel(video, x, y) {
    const across = (x + 0.5 - video.leftBorder) / (FbWidth - video.leftBorder - video.rightBorder);
    const down = (y + 0.5 - video.topBorder) / (FbHeight - video.topBorder - video.bottomBorder);
    return video.addressShownAt(across, down);
}

/** A machine in `mode`, scrolled so its picture starts part way through its memory and wraps. */
async function scrolledMachine(model, mode) {
    const video = new FrameCapturingVideo(model.startsWith("Master"));
    const machine = new TestMachine(model, { video });
    await machine.initialise();
    await machine.runUntilInput();
    await machine.type(`MODE ${mode}:VDU 23,1,0;0;0;0;:FOR I=1 TO 37:PRINT:NEXT`);
    await machine.runUntilInput();
    const blank = mode === Teletext ? TeletextBlank : 0;
    for (let address = ScreenBase[mode]; address < 0x8000; ++address) machine.writebyte(address, blank);
    await machine.runFor(PictureCycles);
    return { machine, video, blank };
}

describe("the address of the byte drawn at a point of the screen", () => {
    it.each([
        ["B-DFS1.2", 0],
        ["B-DFS1.2", 1],
        ["B-DFS1.2", 2],
        ["B-DFS1.2", 3],
        ["B-DFS1.2", 4],
        ["B-DFS1.2", 5],
        ["B-DFS1.2", 6],
        ["B-DFS1.2", 7],
        ["Master", 7],
    ])("is the byte that lights it, on a %s in MODE %i", async (model, mode) => {
        const { machine, video, blank } = await scrolledMachine(model, mode);
        const lit = mode === Teletext ? TeletextW : LitByte(mode);
        const base = ScreenBase[mode];
        const step = Math.floor((0x8000 - base) / SamplesPerMode);
        const found = [];
        const drawn = [];
        for (let address = base; address < 0x8000; address += step) {
            const before = video.frame;
            machine.writebyte(address, lit);
            await machine.runFor(PictureCycles);
            const box = changedBox(before, video.frame);
            machine.writebyte(address, blank);
            await machine.runFor(PictureCycles);
            // MODE 3, 6 and 7 leave some of their memory off the picture.
            if (!box) continue;
            drawn.push(address);
            for (const [x, y] of [
                [box.left, box.top],
                [(box.left + box.right) >> 1, (box.top + box.bottom) >> 1],
                [box.right, box.bottom],
            ])
                found.push(addressAtPixel(video, x, y));
        }
        expect(drawn.length).toBeGreaterThanOrEqual(SamplesPerMode - 2);
        expect(found).toEqual(drawn.flatMap((address) => [address, address, address]));
    });

    it("is nothing in the border, off the picture, or on a machine without a CRTC", async () => {
        const { video } = await scrolledMachine("B-DFS1.2", 0);
        for (const [x, y] of [
            [0, 0],
            [0.999, 0.999],
            [-0.01, 0.5],
            [0.5, 1],
        ])
            expect(video.addressShownAt(x, y)).toBeNull();
        expect(video.addressShownAt(0.5, 0.5)).not.toBeNull();

        const atom = new Video(false, FbWidth * FbHeight, () => {}, { isAtom: true });
        expect(atom.addressShownAt(0.5, 0.5)).toBeNull();
        expect(new FakeVideo().addressShownAt(0.5, 0.5)).toBeNull();
    });
});
