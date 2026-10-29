// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findModel } from "../../src/models.js";
import { HwScrollSubtract, Video } from "../../src/video.js";
import { CrtcPanel, screenAddress } from "../../src/web/crtc-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { decodedMeanings, teardownDom } from "./helpers.js";

const FramebufferPixels = 1024 * 768;
const MaValues = 0x4000;
const ScanlineClocks = 128;
const FrameClocks = ScanlineClocks * 312;

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

    it("is made for a BBC or a Master, not for an Atom, whose video is a 6847", () => {
        const fits = (name) => CrtcPanel.fits({ model: findModel(name) });
        expect([fits("B-DFS1.2"), fits("Master"), fits("Atom")]).toEqual([true, true, false]);
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
        expect(meanings("R9")).toEqual(["19 lines, 10 a field"]);
        expect(meanings("R12/13")).toEqual(["at &7c00", "-wrapped"]);
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
