"use strict";

// Test screens drawn on a real emulated BBC, for tools/verify-xbr-shader.js.
// They are drawn from BASIC so the capture goes through the real video path —
// palette, ULA modes, teletext — rather than a synthetic bitmap that might not
// resemble anything the emulator actually produces.

import path from "path";
import { TestMachine } from "../tests/test-machine.js";
import { Video } from "../src/video.js";
import { setNodeBasePath } from "../src/utils.js";

export const FbWidth = 1024;
const FbHeight = 625;

export const Scenes = [
    {
        name: "mode1-diagonals",
        description: "MODE 1 lines and circles — the classic hard case for a scaler",
        program: [
            "MODE 1",
            "VDU 23,1,0;0;0;0;",
            "GCOL 0,1",
            "FOR I%=0 TO 1279 STEP 64:MOVE 0,0:DRAW I%,1023:NEXT",
            "GCOL 0,2",
            "FOR I%=0 TO 1023 STEP 128:MOVE 1279,I%:DRAW 0,I%+40:NEXT",
            "GCOL 0,3",
            "MOVE 200,500:FOR A=0 TO 6.3 STEP 0.05:DRAW 640+300*COS(A),500+300*SIN(A):NEXT",
        ],
    },
    {
        name: "mode2-chunky",
        description: "MODE 2 — 160 pixels across, each four framebuffer texels wide",
        program: [
            "MODE 2",
            "VDU 23,1,0;0;0;0;",
            "FOR C%=1 TO 7:GCOL 0,C%",
            "MOVE 0,C%*128:DRAW 1279,C%*128-100:NEXT",
            "GCOL 0,5",
            "MOVE 300,300:FOR A=0 TO 6.3 STEP 0.05:DRAW 640+280*COS(A),512+280*SIN(A):NEXT",
        ],
    },
    {
        name: "mode0-text",
        description: "MODE 0 — 640 pixels across, one texel per pixel, mostly text",
        program: [
            "MODE 0",
            "VDU 23,1,0;0;0;0;",
            'FOR I%=1 TO 12:PRINT "The quick brown fox jumps over the lazy dog 0123456789";:NEXT',
            "MOVE 0,0:DRAW 1279,700:MOVE 0,700:DRAW 1279,0",
        ],
    },
    {
        name: "mode7-teletext",
        description: "MODE 7 — SAA5050 output, already at framebuffer resolution",
        program: [
            "MODE 7",
            "VDU 23,1,0;0;0;0;",
            'PRINT CHR$(141);CHR$(131);"jsbeeb upscaling test"',
            'PRINT CHR$(141);CHR$(131);"jsbeeb upscaling test"',
            'FOR I%=0 TO 5:PRINT CHR$(129+I%);"Teletext graphics ";CHR$(151);',
            "FOR J%=1 TO 20:PRINT CHR$(160+(I%*7+J%) MOD 64);:NEXT:PRINT:NEXT",
        ],
    },
    {
        name: "mode5-chunky",
        description: "MODE 5 — four colours, 160 pixels across, drawn from BASIC",
        program: [
            "MODE 5",
            "VDU 23,1,0;0;0;0;",
            "FOR C%=1 TO 3:GCOL 0,C%",
            "MOVE 0,C%*200:DRAW 1279,C%*200+150:NEXT",
            "GCOL 0,2:MOVE 400,100:FOR A=0 TO 6.3 STEP 0.05:DRAW 640+200*COS(A),400+200*SIN(A):NEXT",
        ],
    },
];

/** A Video that keeps a complete copy of each painted frame and its line grid. */
class CapturingVideo extends Video {
    constructor() {
        super(false, new Uint32Array(FbWidth * FbHeight), () => {});
        this.paint_ext = (left, top, right, bottom) => this._onPaint(left, top, right, bottom);
        this._wanted = false;
        this.captured = null;
    }

    _onPaint(left, top, right, bottom) {
        if (!this._wanted) return;
        this._wanted = false;
        this.captured = { fb32: this.fb32.slice(), lineGrid: this.lineGrid.slice(), left, top, right, bottom };
    }

    async capture(testMachine) {
        this._wanted = true;
        this.captured = null;
        for (let attempt = 0; attempt < 10 && !this.captured; ++attempt) await testMachine.runUntilVblank();
        if (!this.captured) throw new Error("No frame was painted");
        return this.captured;
    }
}

/** Trim fully-black rows and columns so each scene is compared over its picture. */
function visibleExtent(frame) {
    const { fb32, left, top, right, bottom } = frame;
    let minX = right;
    let maxX = left;
    let minY = bottom;
    let maxY = top;
    for (let y = top; y < bottom; ++y) {
        for (let x = left; x < right; ++x) {
            if ((fb32[y * FbWidth + x] & 0x00ffffff) === 0) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (minX > maxX) return { left, top, right, bottom };
    return { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 };
}

/**
 * Boot a machine, draw the scene, and capture one complete frame.
 *
 * @returns {Promise<{frame: Object, extent: {left: number, top: number, right: number, bottom: number}}>}
 */
export async function captureScene(scene, model = "B-DFS1.2") {
    setNodeBasePath(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
    const video = new CapturingVideo();
    const machine = new TestMachine(model, { video });
    await machine.initialise();
    await machine.runUntilInput();
    for (const line of scene.program) await machine.type(line);
    // Let the drawing finish and the screen settle.
    await machine.runFor(20 * 1000 * 1000);
    const frame = await video.capture(machine);
    return { frame, extent: visibleExtent(frame) };
}
