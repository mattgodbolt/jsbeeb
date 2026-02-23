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

        // (WRCHV tracking is done inside _installCaptureHook via direct ramRomOs reads)
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
     * Strategy for finding WRCHV:
     *   RAM at 0x20E/0x20F initialises to 0xFFFF before the OS runs.  We
     *   read it directly from the raw ramRomOs Uint8Array (two array lookups
     *   — far cheaper than a readmem() dispatch) on every instruction until
     *   the value changes from its initial 0xFFFF.  Once the OS has set a
     *   real handler address we treat that as WRCHV for the lifetime of the
     *   hook.  Programs that later install a custom VDU handler will change
     *   0x20E automatically and the hook picks it up seamlessly.
     *
     * MODE 7 (Teletext) notes:
     *   - Colour changes come through as VDU 17 + param, exactly as in other
     *     modes.  Param 8 = flash on, 9 = steady (not a regular colour).
     *   - Double-height arrives as raw byte 0x8D (VDU 141), single-height as
     *     0x8C (VDU 140).  These have bit 7 set and bypass the normal VDU
     *     dispatch, so we handle them explicitly.
     *   - Teletext graphics characters (0xA0–0xFF) are mosaic/block glyphs.
     *     We flush any pending text and skip them; screenshots show them
     *     correctly via the real Video chip.
     *
     * Text elements emitted to _pendingOutput:
     *   { x, y, text, foreground, background, mode, flash, doubleHeight }
     */
    _installCaptureHook() {
        const cpu = this._machine.processor;
        // Direct Uint8Array access — bypasses readmem() dispatch entirely.
        const ram = cpu.ramRomOs;
        const initialWrchv = ram[0x20e] | (ram[0x20f] << 8); // 0xFFFF pre-boot

        const attributes = {
            x: 0,
            y: 0,
            text: "",
            foreground: 7,
            background: 0,
            mode: 7,
            flash: false,
            doubleHeight: false,
        };
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
            // Consume pending VDU parameter bytes first.
            if (nextN) {
                params.push(c);
                if (--nextN === 0) {
                    if (vduProc) vduProc(params);
                    params = [];
                    vduProc = null;
                }
                return;
            }

            // MODE 7 raw teletext control bytes (0x80–0x9F, bit 7 set).
            // The OS sends 0x8C (single-height) and 0x8D (double-height)
            // directly through WRCHV for MODE 7 programs.
            if (c >= 0x80 && c <= 0x9f) {
                const code = c & 0x7f; // teletext code 0–31
                flush();
                if (code === 12) attributes.doubleHeight = false; // VDU 140
                if (code === 13) attributes.doubleHeight = true; // VDU 141
                // Other teletext control codes (0x81–0x87 alpha colour,
                // 0x91–0x97 graphics colour, etc.) don't appear at WRCHV
                // level in practice — colour changes come via VDU 17 below.
                return;
            }

            // MODE 7 mosaic/block graphics characters (0xA0–0xFF).
            // These are visual glyphs; the screenshot shows them correctly.
            // Skip here rather than emit unintelligible characters.
            if (c >= 0xa0) {
                flush();
                return;
            }

            // Standard VDU control codes (0x00–0x1F).
            switch (c) {
                case 1: // next char → printer only
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
                        const n = p[0];
                        if (n & 0x80) {
                            // Background colour (bit 7 set); low 3 bits = colour.
                            attributes.background = n & 0x7;
                        } else if (n === 8) {
                            // MODE 7 flash on (COLOUR 8).
                            attributes.flash = true;
                        } else if (n === 9) {
                            // MODE 7 steady (COLOUR 9).
                            attributes.flash = false;
                        } else {
                            // Foreground colour 0–7.
                            attributes.foreground = n & 0xf;
                        }
                    };
                    break;
                case 18: // GCOL
                    nextN = 2;
                    break;
                case 19: // define logical colour
                    nextN = 5;
                    break;
                case 22: // MODE n — reset all per-mode state
                    nextN = 1;
                    vduProc = (p) => {
                        flush();
                        attributes.mode = p[0];
                        attributes.x = 0;
                        attributes.y = 0;
                        attributes.foreground = 7;
                        attributes.background = 0;
                        attributes.flash = false;
                        attributes.doubleHeight = false;
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
