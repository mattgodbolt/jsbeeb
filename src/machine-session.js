/**
 * MachineSession - wraps jsbeeb's TestMachine with:
 *   - real Video framebuffer (so screenshots work)
 *   - accumulated text output between calls
 *   - clean lifecycle (boot, interact, screenshot, destroy)
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { TestMachine } from "../tests/test-machine.js";

// Resolve the jsbeeb package root from our own location (src/machine-session.js
// → go up one level).  Passed to setNodeBasePath() so the ROM loader resolves
// files relative to this package regardless of the calling process's cwd.
const _jsbeebRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
import * as fdc from "./fdc.js";
import { Video } from "./video.js";
import { findModel } from "./models.js";
import { setNodeBasePath } from "./utils.js";
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

        // Raw RGBA framebuffer — the Video chip renders into _fb32 (cleared each frame).
        // _completeFb8 is a snapshot taken at paint time (the equivalent of the browser canvas)
        // and is what screenshot() reads from — always a complete frame, never mid-render.
        this._fb8 = new Uint8Array(FB_WIDTH * FB_HEIGHT * 4);
        this._fb32 = new Uint32Array(this._fb8.buffer);
        this._completeFb8 = new Uint8Array(FB_WIDTH * FB_HEIGHT * 4);
        this._lastPaint = { minx: 0, miny: 0, maxx: FB_WIDTH, maxy: FB_HEIGHT };
        this._frameDirty = false;

        // Create a real Video instance so we get pixel output
        const modelObj = findModel(modelName);
        this._video = new Video(modelObj.isMaster, this._fb32, (minx, miny, maxx, maxy) => {
            this._lastPaint = { minx, miny, maxx, maxy };
            this._frameDirty = true;
            // Snapshot the complete frame now, before clearPaintBuffer() wipes _fb32.
            // This mirrors what the browser does: paint_ext fires → canvas updated → fb32 cleared.
            this._completeFb8.set(this._fb8);
        });

        // TestMachine forwards opts.video to fake6502, which uses it instead of FakeVideo
        this._machine = new TestMachine(modelName, { video: this._video });

        // Accumulated VDU text output — drained by callers
        this._pendingOutput = [];
    }

    /** Load ROMs and hardware — call once before anything else */
    async initialise() {
        setNodeBasePath(_jsbeebRoot);
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
     * WRCHV discovery: RAM at 0x20E/0x20F initialises to 0xFFFF before the
     * OS runs.  We read directly from cpu.ramRomOs (two array lookups — no
     * readmem() dispatch overhead) on every instruction, waiting for the
     * value to change from its initial 0xFFFF.  Once the OS installs a real
     * handler we use that address for the lifetime of the session.  Programs
     * that later install a custom VDU driver are handled seamlessly because
     * we always re-read from the live memory.
     *
     * Text elements: { x, y, text, foreground, background, mode }
     * Screenshots (via the real Video chip) are the right tool for anything
     * visual; this capture is a lightweight aid for text-mode output only.
     */
    _installCaptureHook() {
        const cpu = this._machine.processor;
        const ram = cpu.ramRomOs; // direct Uint8Array — no dispatch overhead
        const initialWrchv = ram[0x20e] | (ram[0x20f] << 8); // 0xFFFF pre-boot

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
                case 1: // next char to printer only
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
                case 17: // COLOUR n
                    nextN = 1;
                    vduProc = (p) => {
                        if (p[0] & 0x80) attributes.background = p[0] & 0xf;
                        else attributes.foreground = p[0] & 0xf;
                    };
                    break;
                case 18: // GCOL
                    nextN = 2;
                    break;
                case 19: // define logical colour
                    nextN = 5;
                    break;
                case 22: // MODE n
                    nextN = 1;
                    vduProc = (p) => {
                        flush();
                        attributes.mode = p[0];
                        attributes.x = 0;
                        attributes.y = 0;
                        attributes.foreground = 7;
                        attributes.background = 0;
                    };
                    break;
                case 25: // PLOT
                    nextN = 5;
                    break;
                case 28: // define text window
                    nextN = 4;
                    break;
                case 29: // define graphics origin
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

        cpu.debugInstruction.add((addr) => {
            // Two direct array reads — no function-call dispatch overhead.
            // Once the OS sets WRCHV (it changes from 0xFFFF), we start
            // capturing.  Programs that install a custom VDU driver mid-run
            // are handled transparently because we re-read on every call.
            const wrchv = ram[0x20e] | (ram[0x20f] << 8);
            if (wrchv !== initialWrchv && addr === wrchv) {
                onChar(cpu.a);
            }
            return false;
        });
    }

    /**
     * Press a key (by browser keyCode).
     * Use utils.keyCodes for named keys, or ASCII charCode for letters/digits.
     */
    keyDown(keyCode, shiftDown = false) {
        this._machine.processor.sysvia.keyDown(keyCode, shiftDown);
    }

    /**
     * Release a key (by browser keyCode).
     */
    keyUp(keyCode) {
        this._machine.processor.sysvia.keyUp(keyCode);
    }

    /**
     * Reset the machine.
     * @param {boolean} [hard=true] - true for power-on reset, false for soft reset
     */
    reset(hard = true) {
        this._machine.processor.reset(hard);
        this._pendingOutput = [];
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
     * until timeoutSecs of emulated time elapses.  Returns captured output.
     *
     * @param {number} [timeoutSecs=60]
     * @param {Object} [opts]
     * @param {boolean} [opts.clear=true] - Whether to clear the output buffer after returning it.
     */
    async runUntilPrompt(timeoutSecs = 60, { clear = true } = {}) {
        await this._machine.runUntilInput(timeoutSecs);
        return this.drainOutput({ clear });
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

    /**
     * Load a disc image (absolute or relative path to an .ssd or .dsd file).
     *
     * We read the file ourselves rather than delegating to TestMachine.loadDisc,
     * which goes through utils.loadData and mangles absolute paths by prepending "./".
     */
    loadDisc(imagePath) {
        const data = new Uint8Array(readFileSync(imagePath));
        this._machine.processor.fdc.loadDisc(0, fdc.discFor(this._machine.processor.fdc, imagePath, data));
    }

    /**
     * Return all VDU text elements captured so far.
     *
     * @param {Object} [opts]
     * @param {boolean} [opts.clear=true] - If true (default), clear the buffer
     *   after returning it.  Pass false to peek without consuming — the same
     *   elements will be returned again on the next call.
     *
     * Each element: { x, y, text, foreground, background, mode }
     * Also includes a flat `screenText` reconstruction.
     */
    drainOutput({ clear = true } = {}) {
        const elements = clear ? this._pendingOutput.splice(0) : [...this._pendingOutput];
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
        // Read from _completeFb8 — the last fully-painted frame snapshotted in paint_ext.
        // _fb8/_fb32 is the live render buffer (cleared and partially refilled each frame).
        return sharp(Buffer.from(this._completeFb8.buffer), {
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

        return sharp(Buffer.from(this._completeFb8.buffer), {
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
