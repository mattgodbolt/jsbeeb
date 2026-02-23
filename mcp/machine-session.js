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
    }

    /** Load ROMs and hardware — call once before anything else */
    async initialise() {
        await this._machine.initialise();
        this._installCaptureHook();
    }

    /**
     * Boot the machine (run until the BASIC prompt).
     * Returns captured boot-screen text (the OS banner etc.).
     */
    async boot(timeoutSecs = 30) {
        await this._machine.runUntilInput(timeoutSecs);
        return this.drainOutput();
    }

    /**
     * Install the VDU character-output capture hook.
     *
     * Rather than using TestMachine.captureText() — which reads WRCHV from
     * 0x20E once at installation time — we read it dynamically on every
     * instruction.  This means:
     *
     *   - We can install it before the OS has run (WRCHV == 0 → no false
     *     fires), so we capture the boot banner as well as program output.
     *   - Programs that install their own VDU handler (changing WRCHV) are
     *     handled transparently.
     *
     * The VDU state machine below is a duplicate of the one in
     * TestMachine.captureText() (tests/test-machine.js).  If that code
     * changes, update this too — or better, extract a shared helper.
     */
    _installCaptureHook() {
        const attributes = { x: 0, y: 0, text: "", foreground: 7, background: 0, mode: 7 };
        let currentText = "";
        let params = [];
        let nextN = 0;
        let vduProc = null;

        const onElement = (elem) => this._pendingOutput.push({ ...elem });

        function flush() {
            if (currentText.length) {
                attributes.text = currentText;
                onElement({ ...attributes });
                attributes.x += currentText.length;
            }
            currentText = "";
        }

        function onChar(c) {
            if (nextN) {
                params.push(c);
                if (--nextN === 0) {
                    if (vduProc) vduProc(params);
                    params = [];
                    vduProc = null;
                }
                return;
            }
            switch (c) {
                case 1: // Next char to printer
                    nextN = 1;
                    break;
                case 10: // LF
                    flush();
                    attributes.y++;
                    break;
                case 12: // CLS
                    flush();
                    attributes.x = 0;
                    attributes.y = 0;
                    break;
                case 13: // CR
                    flush();
                    attributes.x = 0;
                    break;
                case 17: // COLOUR
                    nextN = 1;
                    vduProc = (p) => {
                        if (p[0] & 0x80) attributes.background = p[0] & 0xf;
                        else attributes.foreground = p[0] & 0xf;
                    };
                    break;
                case 18: // GCOL
                    nextN = 2;
                    break;
                case 19: // logical colour
                    nextN = 5;
                    break;
                case 22: // MODE
                    nextN = 1;
                    vduProc = (p) => {
                        attributes.mode = p[0];
                        attributes.x = 0;
                        attributes.y = 0;
                    };
                    break;
                case 25: // PLOT
                    nextN = 5;
                    break;
                case 28: // text window
                    nextN = 4;
                    break;
                case 29: // origin
                    nextN = 4;
                    break;
                case 31: // TAB(x,y)
                    nextN = 2;
                    vduProc = (p) => {
                        flush();
                        attributes.x = p[0];
                        attributes.y = p[1];
                    };
                    break;
                default:
                    if (c >= 32 && c < 0x7f) {
                        currentText += String.fromCharCode(c);
                    } else {
                        flush();
                    }
                    break;
            }
        }

        this._machine.processor.debugInstruction.add((addr) => {
            // Read WRCHV dynamically: handles pre-boot (wrchv==0 → skip) and
            // programs that install a custom VDU driver mid-run.
            const wrchv = this._machine.readword(0x20e);
            if (wrchv > 0 && addr === wrchv) {
                onChar(this._machine.processor.a);
            }
            return false;
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
