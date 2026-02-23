/**
 * MachineSession - wraps jsbeeb's TestMachine with:
 *   - real Video framebuffer (so screenshots work)
 *   - accumulated text output between calls
 *   - clean lifecycle (boot, interact, screenshot, destroy)
 */

import { TestMachine } from "../tests/test-machine.js";
import { Video } from "../src/video.js";
import { findModel } from "../src/models.js";
import sharp from "sharp";

// BBC framebuffer is 1024×625 pixels
const FB_WIDTH = 1024;
const FB_HEIGHT = 625;

export class MachineSession {
    /**
     * @param {string} modelName - e.g. "B-DFS1.2", "Master"
     */
    constructor(modelName = "B-DFS1.2") {
        this.modelName = modelName;

        // Raw RGBA framebuffer — shared between Uint8Array (for PNG encoding)
        // and Uint32Array (which Video writes into as ABGR uint32s on LE = RGBA bytes)
        this._fb8 = new Uint8Array(FB_WIDTH * FB_HEIGHT * 4);
        this._fb32 = new Uint32Array(this._fb8.buffer);
        this._lastPaint = { minx: 0, miny: 0, maxx: FB_WIDTH, maxy: FB_HEIGHT };
        this._frameDirty = false;

        // Create a real Video instance so we get pixel output
        const modelObj = findModel(modelName);
        this._video = new Video(modelObj.isMaster, this._fb32, (minx, miny, maxx, maxy) => {
            this._lastPaint = { minx, miny, maxx, maxy };
            this._frameDirty = true;
        });

        // TestMachine forwards opts.video to fake6502, which uses it instead of FakeVideo
        this._machine = new TestMachine(modelName, { video: this._video });

        // Accumulated VDU text output — drained by callers
        this._pendingOutput = [];
        this._captureInstalled = false;
    }

    /** Load ROMs and hardware — call once before anything else */
    async initialise() {
        await this._machine.initialise();
    }

    /**
     * Boot the machine (run until the BASIC prompt), then install the VDU
     * text capture hook.  Returns the boot-screen text.
     */
    async boot(timeoutSecs = 30) {
        await this._machine.runUntilInput(timeoutSecs);
        this._installCaptureHook();
        return this.drainOutput();
    }

    /**
     * Install the VDU character-output hook.  Safe to call only after the OS
     * has booted (WRCHV at 0x20E must be valid).
     */
    _installCaptureHook() {
        if (this._captureInstalled) return;
        this._captureInstalled = true;
        this._machine.captureText((elem) => {
            this._pendingOutput.push({ ...elem });
        });
    }

    /** Tokenise BBC BASIC source and write it into PAGE */
    async loadBasic(source) {
        await this._machine.loadBasic(source);
    }

    /**
     * Simulate keypresses.  Note: each character needs a short run to be
     * picked up by the OS, so this is internally async and slow-ish (by
     * emulated-time).
     */
    async type(text) {
        await this._machine.type(text);
    }

    /**
     * Run the emulator until the OS is waiting at the keyboard prompt, or
     * until timeoutSecs of emulated time elapses.  Returns drained output.
     */
    async runUntilPrompt(timeoutSecs = 60) {
        await this._machine.runUntilInput(timeoutSecs);
        return this.drainOutput();
    }

    /**
     * Run for an exact number of emulated CPU cycles.
     * Useful for timing-sensitive code.
     */
    async runFor(cycles) {
        await this._machine.runFor(cycles);
    }

    /**
     * Run until PC reaches targetAddr (like a breakpoint), or timeout.
     */
    async runUntilAddress(addr, timeoutSecs = 30) {
        await this._machine.runUntilAddress(addr, timeoutSecs);
    }

    /** Load a disc image (path to .ssd/.dsd file) */
    async loadDisc(imagePath) {
        await this._machine.loadDisc(imagePath);
    }

    /**
     * Drain and return all VDU text elements captured since the last drain.
     *
     * Each element: { x, y, text, foreground, background, mode }
     * Also includes a flat `screenText` reconstruction.
     */
    drainOutput() {
        const elements = this._pendingOutput.splice(0);
        return {
            elements,
            screenText: reconstructScreenText(elements),
        };
    }

    /** Read `length` bytes from emulator memory starting at `address` */
    readMemory(address, length = 16) {
        const bytes = [];
        for (let i = 0; i < length; i++) {
            bytes.push(this._machine.readbyte(address + i));
        }
        return bytes;
    }

    /** Write an array of byte values into emulator memory at `address` */
    writeMemory(address, bytes) {
        for (let i = 0; i < bytes.length; i++) {
            this._machine.writebyte(address + i, bytes[i]);
        }
    }

    /** Read the current 6502 CPU registers */
    registers() {
        const cpu = this._machine.processor;
        return {
            pc: cpu.pc,
            a: cpu.a,
            x: cpu.x,
            y: cpu.y,
            s: cpu.s, // stack pointer
            p: cpu.p, // processor status
            pcHex: `0x${cpu.pc.toString(16).toUpperCase().padStart(4, "0")}`,
            aHex: `0x${cpu.a.toString(16).toUpperCase().padStart(2, "0")}`,
            xHex: `0x${cpu.x.toString(16).toUpperCase().padStart(2, "0")}`,
            yHex: `0x${cpu.y.toString(16).toUpperCase().padStart(2, "0")}`,
        };
    }

    /**
     * Capture the current screen as a PNG.
     * Returns a Buffer containing a 1024×625 PNG (the full emulated display,
     * including borders — matches what the browser renders).
     *
     * The active display area is roughly:
     *   x: leftBorder .. 1024-rightBorder
     *   y: topBorder  .. 625-bottomBorder
     */
    async screenshot() {
        // fb8 is RGBA bytes (each pixel: [R, G, B, A] on little-endian)
        return sharp(Buffer.from(this._fb8.buffer), {
            raw: { width: FB_WIDTH, height: FB_HEIGHT, channels: 4 },
        })
            .png()
            .toBuffer();
    }

    /**
     * Capture only the active display area (no overscan borders), scaled to
     * a more sensible pixel density.  Returns a PNG Buffer.
     *
     * @param {Object} [opts]
     * @param {number} [opts.scale=2]  - integer scale factor
     */
    async screenshotActive(opts = {}) {
        const scale = opts.scale ?? 2;
        const v = this._video;
        const left = v.leftBorder;
        const top = v.topBorder;
        const right = v.rightBorder;
        const bottom = v.bottomBorder;
        const w = FB_WIDTH - left - right;
        const h = FB_HEIGHT - top - bottom;

        return sharp(Buffer.from(this._fb8.buffer), {
            raw: { width: FB_WIDTH, height: FB_HEIGHT, channels: 4 },
        })
            .extract({ left, top, width: w, height: h })
            .resize(w * scale, h * scale, { kernel: "nearest" }) // nearest-neighbour keeps pixels crisp
            .png()
            .toBuffer();
    }

    /** Free any resources (currently just clears the framebuffer) */
    destroy() {
        this._fb8.fill(0);
        this._pendingOutput = [];
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reconstruct a flat text representation from the captured VDU elements.
 * Builds a 2D grid of characters and returns it as a newline-separated string.
 */
function reconstructScreenText(elements) {
    if (elements.length === 0) return "";

    // Find bounds
    let maxX = 0;
    let maxY = 0;
    for (const el of elements) {
        const endX = el.x + el.text.length;
        if (endX > maxX) maxX = endX;
        if (el.y > maxY) maxY = el.y;
    }

    // Fill grid
    const rows = Array.from({ length: maxY + 1 }, () => Array(maxX + 1).fill(" "));
    for (const el of elements) {
        for (let i = 0; i < el.text.length; i++) {
            const col = el.x + i;
            if (col < rows[el.y].length) {
                rows[el.y][col] = el.text[i];
            }
        }
    }

    return rows.map((r) => r.join("").trimEnd()).join("\n");
}
