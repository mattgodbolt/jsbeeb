// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findModel } from "../../src/models.js";
import { FakeVideo, HwScrollSubtract, Video } from "../../src/video.js";
import { CrtcPanel, screenAddress } from "../../src/web/crtc-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { decodedMeanings, teardownDom } from "./helpers.js";

const FramebufferPixels = 1024 * 768;
const MaValues = 0x4000;
const ScanlineClocks = 128;
const ScanlineCount = 312;
const FrameClocks = ScanlineClocks * ScanlineCount;
const Mode7LineClocksAt2Mhz = 64;
const SteadyCursor = 0x07;
const HiddenCursor = 0x27;

// What the MOS programs for MODE 1 and MODE 7, R0 to R13.
const Mode1 = [0x7f, 0x50, 0x62, 0x28, 0x26, 0x00, 0x20, 0x22, 0x01, 0x07, 0x67, 0x08, 0x06, 0x00];
const Mode7 = [0x3f, 0x28, 0x33, 0x24, 0x1e, 0x02, 0x19, 0x1b, 0x93, 0x12, 0x72, 0x13, 0x28, 0x00];

function makeVideo(isMaster) {
    const video = new Video(isMaster, FramebufferPixels, () => {});
    const reads = [];
    video.reset({ interrupt: 0, videoRead: (address) => reads.push(address) }, { setVBlankInt: () => {} });
    return { video, reads };
}

function program(video, values) {
    for (const [register, value] of values.entries()) {
        video.crtc.write(0, register);
        video.crtc.write(1, value);
    }
}

describe("CrtcPanel", () => {
    let video;
    let panel;

    beforeEach(() => {
        ({ video } = makeVideo(false));
        panel = new CrtcPanel({ cpu: { video }, arrangement: new PanelArrangement(() => window.localStorage) });
    });

    afterEach(teardownDom);

    const meanings = (name) => decodedMeanings("crtc-panel", name);

    it("is made for a BBC or a Master, not for an Atom, whose video is a 6847, nor for a machine with fake video", () => {
        const fits = (name, fake) => CrtcPanel.fits({ model: findModel(name), video: fake ? new FakeVideo() : video });
        expect([fits("B-DFS1.2", false), fits("Master", false), fits("Atom", false), fits("B-DFS1.2", true)]).toEqual([
            true,
            true,
            false,
            false,
        ]);
    });

    it("spells out MODE 1's timing, interlace, cursor and screen start", () => {
        program(video, Mode1);
        panel.update();
        expect(meanings("R0")).toEqual(["128 chars, 64 µs"]);
        expect(meanings("R3")).toEqual(["hsync 8 chars", "vsync 2 lines"]);
        expect(meanings("R4")).toEqual(["39 rows, 312 lines"]);
        expect(meanings("R8")).toEqual(["interlace sync", "display delay 0", "cursor delay 0"]);
        expect(meanings("R9")).toEqual(["8 lines"]);
        expect(meanings("R10").slice(0, 2)).toEqual(["from line 7", "cursor blinks slow"]);
        expect(meanings("R12/13")).toEqual(["at &3000", "-wrapped"]);
    });

    it("spells out MODE 7's interlaced rows of alternate scanlines, and its screen in teletext's 1K", () => {
        program(video, Mode7);
        panel.update();
        expect(meanings("R4")).toEqual(["31 rows, 312 lines"]);
        expect(meanings("R8")).toEqual(["interlace sync and video", "display delay 1", "cursor delay 2"]);
        expect(meanings("R9")).toEqual(["20 lines, 10 a field"]);
        expect(meanings("R12/13")).toEqual(["at &7c00", "-wrapped"]);
    });

    it("gives a line's length at the 1 MHz character clock, and a vsync width of 0 as 16", () => {
        program(video, [...Mode1.slice(0, 3), 0x08]);
        video.ula.write(0, 0);
        panel.update();
        expect(meanings("R0")).toEqual(["128 chars, 128 µs"]);
        expect(meanings("R3")).toEqual(["hsync 8 chars", "vsync 16 lines"]);
    });

    it("lights the cursor as shown in a field its blink shows it in", () => {
        program(video, [...Mode1.slice(0, 10), SteadyCursor]);
        video.polltime(2 * FrameClocks);
        panel.update();
        expect(meanings("R10")).toEqual(["from line 7", "cursor steady", "+shown"]);
        program(video, [...Mode1.slice(0, 10), HiddenCursor]);
        video.polltime(2 * FrameClocks);
        panel.update();
        expect(meanings("R10")).toEqual(["from line 7", "cursor hidden", "-shown"]);
    });

    it("follows the counters to a character, giving the byte read and the row's start in memory", () => {
        program(video, Mode1);
        const at = (char, scanline, row) =>
            video.horizCounter === char && video.scanlineCounter === scanline && video.vertCounter === row;
        video.polltime(FrameClocks);
        while (!at(0, 2, 1)) video.polltime(1);
        panel.update();
        expect(meanings("C0")).toEqual(["char 0 of 128", "+displayed", "-hsync"]);
        expect(meanings("C9")[0]).toBe("line 2 of 8");
        expect(meanings("C4")).toEqual(["row 1 of 39", "+displayed", "-vsync", "-adjust", "-dummy"]);
        expect(meanings("MA")).toEqual(["reads &3282", "row &3280"]);
    });

    it("counts MODE 7's rows in both fields' scanlines, adding the dummy scanline to the even field only, and lights the odd field only while interlaced", () => {
        program(video, Mode7);
        const inDummy = new Set();
        const fields = new Set();
        const lines = new Set();
        for (let line = 0; line < 8 * ScanlineCount; ++line) {
            video.polltime(Mode7LineClocksAt2Mhz);
            panel.update();
            const [scanline, field] = meanings("C9");
            (video.inDummyRaster ? inDummy : fields).add(field);
            if (meanings("C4")[1] === "+displayed") lines.add(`${scanline} ${field}`);
        }
        expect([[...inDummy], [...fields].sort()]).toEqual([["-odd field"], ["+odd field", "-odd field"]]);
        expect([...lines]).toEqual(expect.arrayContaining(["line 0 of 20 -odd field", "line 19 of 20 +odd field"]));
        const parityMismatches = [...lines].filter((seen) => {
            const [, line, odd] = seen.match(/^line (\d+) of 20 ([+-])odd field$/);
            return Number(line) % 2 !== (odd === "+" ? 1 : 0);
        });
        expect(parityMismatches).toEqual([]);
        program(video, [...Mode7.slice(0, 8), 0x90]);
        const odd = new Set();
        for (let field = 0; field < 4; ++field) {
            video.polltime(FrameClocks);
            panel.update();
            odd.add(meanings("C9")[1]);
        }
        expect([...odd]).toEqual(["-odd field"]);
    });

    it("gives a screen start past &8000 where IC32's screen size wraps it", () => {
        program(video, [...Mode1.slice(0, 12), 0x10, 0x00]);
        video.setScreenHwScroll(2);
        panel.update();
        expect(meanings("R12/13")).toEqual(["at &3000", "+wrapped"]);
    });

    it("follows the counters into vertical sync at R7's row", () => {
        program(video, Mode1);
        video.polltime(FrameClocks);
        while (!video.inVSync) video.polltime(ScanlineClocks);
        panel.update();
        expect(meanings("C4")).toEqual(["row 34 of 39", "-displayed", "+vsync", "-adjust", "-dummy"]);
    });

    it.each([false, true])(
        "reads where the video reads, for every address and screen size (Master: %s)",
        (isMaster) => {
            const { video: machineVideo, reads } = makeVideo(isMaster);
            const expected = [];
            for (const [size, screenSubtract] of HwScrollSubtract.entries()) {
                machineVideo.setScreenHwScroll(size);
                for (let ma = 0; ma < MaValues; ++ma) {
                    const rowAddress = ma & 7;
                    machineVideo.addr = ma;
                    machineVideo.scanlineCounter = rowAddress;
                    machineVideo.readVideoMem();
                    expected.push(screenAddress(ma, rowAddress, { screenSubtract, isMaster }));
                }
            }
            expect(reads).toEqual(expected);
        },
    );
});
