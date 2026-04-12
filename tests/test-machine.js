import * as fdc from "../src/fdc.js";
import { fake6502 } from "../src/fake6502.js";
import { findModel } from "../src/models.js";
import assert from "assert";
import * as utils from "../src/utils.js";
import * as utils_atom from "../src/utils_atom.js";
import * as Tokeniser from "../src/basic-tokenise.js";

const MaxCyclesPerIter = 100 * 1000;

export class TestMachine {
    constructor(model, opts) {
        model = model || "B-DFS1.2";
        const modelObj = findModel(model);
        this.model = modelObj;
        this.processor = fake6502(modelObj, opts || {});
        this._capturedChars = [];
        this._captureHookInstalled = false;
    }

    /** The keyboard interface for this machine (SysVia for BBC, PPIA for Atom). */
    get _keyInterface() {
        return this.model.isAtom ? this.processor.atomppia : this.processor.sysvia;
    }

    async initialise() {
        await this.processor.initialise();
        if (this.model.isAtom) this._startAtomVSync();
    }

    /**
     * The Atom ROM's main loop waits for VSync (bit 7 of Port C) to
     * toggle before scanning the keyboard.  The MC6847 video chip drives
     * this in the real emulator, but fake6502 doesn't create one, so we
     * simulate it with a scheduler task at ~60 Hz (NTSC).
     */
    _startAtomVSync() {
        const ppia = this.processor.atomppia;
        const VsyncPeriod = 16667; // 1 MHz / 60 Hz (NTSC 262-line frame)
        const VsyncPulse = 800;
        let inVsync = false;
        const task = this.processor.scheduler.newTask(() => {
            if (!inVsync) {
                ppia.setVBlankInt(1);
                inVsync = true;
                task.reschedule(VsyncPulse);
            } else {
                ppia.setVBlankInt(0);
                inVsync = false;
                task.reschedule(VsyncPeriod - VsyncPulse);
            }
        });
        task.schedule(VsyncPeriod);
    }

    /**
     * Install the character capture hook (once). All characters sent
     * through WRCHV are accumulated and can be read with drainText().
     * Safe to call multiple times — only installs one hook.
     */
    startCapture() {
        if (this._captureHookInstalled) return;
        this._captureHookInstalled = true;
        // WRCHV is at 0x0208 on Atom, 0x020E on BBC.
        const wrchvAddr = this.model.isAtom ? 0x0208 : 0x020e;
        this.processor.debugInstruction.add((addr) => {
            const wrchv = this.readword(wrchvAddr);
            if (addr === wrchv) {
                this._capturedChars.push(this.processor.a);
            }
            return false;
        });
    }

    /**
     * Return all captured characters since the last drain (or since
     * startCapture was called), then clear the buffer.
     * @returns {number[]} array of character codes
     */
    drainCapturedChars() {
        const chars = this._capturedChars;
        this._capturedChars = [];
        return chars;
    }

    /**
     * Return captured text as a string (printable chars only, with
     * optional newline preservation), then clear the buffer.
     * @param {Object} [opts]
     * @param {boolean} [opts.raw=false] - if true, preserve newlines
     */
    drainText({ raw = false } = {}) {
        const chars = this.drainCapturedChars();
        return chars
            .map((c) => {
                if (raw && c === 10) return "\n";
                if (c === 13) return "";
                if (c >= 0x20 && c < 0x7f) return String.fromCharCode(c);
                return "";
            })
            .join("");
    }

    runFor(cycles) {
        let left = cycles;
        let stopped = false;
        return new Promise((resolve) => {
            const runAnIter = () => {
                const todo = Math.max(0, Math.min(left, MaxCyclesPerIter));
                if (todo) {
                    stopped = !this.processor.execute(todo);
                    left -= todo;
                }
                if (left && !stopped) {
                    setTimeout(runAnIter, 0);
                } else {
                    resolve(stopped);
                }
            };
            runAnIter();
        });
    }

    /**
     * Run until the cursor blink reaches the desired state.
     * This ensures deterministic screenshots regardless of how many
     * cycles were consumed by prior type() or runFor() calls.
     * @param {boolean} on - true for cursor visible, false for hidden
     */
    async runToCursorState(on) {
        const video = this.processor.video;
        for (let i = 0; i < 100; i++) {
            if (video.cursorOnThisFrame === on) return;
            await this.runFor(40000);
        }
        throw new Error(`Cursor did not reach state ${on} in time (cursorOnThisFrame=${video.cursorOnThisFrame})`);
    }

    /**
     * Run until the teletext flash state reaches the desired phase.
     * @param {boolean} on - true for flash-on (flashing cells blanked), false for flash-off
     */
    async runToFlashState(on) {
        const teletext = this.processor.video.teletext;
        for (let i = 0; i < 100; i++) {
            if (teletext.flashOn === on) return;
            await this.runFor(40000);
        }
        throw new Error(`Flash did not reach state ${on} in time (flashOn=${teletext.flashOn})`);
    }

    async runUntilVblank() {
        let hit = false;
        if (this.processor.isMaster) throw new Error("Not yet implemented");
        const hook = this.processor.debugInstruction.add((addr) => {
            if (addr === 0xdd15) {
                hit = true;
                return true;
            }
        });
        await this.runFor(10 * 1000 * 1000);
        hook.remove();
        assert(hit, "did not hit appropriate breakpoint in time");
    }

    async runUntilInput(secs) {
        if (!secs) secs = 120;
        console.log("Running until keyboard input requested");
        if (this.model.isAtom) {
            // The Atom kernel's keyboard read loop at $FE94 is entered when
            // BASIC (or the OS) waits for a keypress.  We detect entry to
            // this routine as the idle point.
            const atomIdleAddr = 0xfe94;
            let hit = false;
            const hook = this.processor.debugInstruction.add((addr) => {
                if (addr === atomIdleAddr) {
                    hit = true;
                    return true;
                }
            });
            await this.runFor(secs * 1 * 1000 * 1000); // Atom is 1 MHz
            hook.remove();
            assert(hit, "Atom did not reach keyboard input in time");
            return this.runFor(10 * 1000);
        }
        const idleAddr = this.processor.model.isMaster ? 0xe7e6 : 0xe581;
        let hit = false;
        const hook = this.processor.debugInstruction.add((addr) => {
            if (addr === idleAddr) {
                hit = true;
                return true;
            }
        });
        await this.runFor(secs * 2 * 1000 * 1000);
        hook.remove();
        assert(hit, "did not hit appropriate breakpoint in time");
        return this.runFor(10 * 1000);
    }

    async runUntilAddress(targetAddr, secs) {
        if (!secs) secs = 120;
        let hit = false;
        const hook = this.processor.debugInstruction.add((addr) => {
            if (addr === targetAddr) {
                hit = true;
                return true;
            }
        });
        await this.runFor(secs * 2 * 1000 * 1000);
        hook.remove();
        assert(hit, "did not hit appropriate breakpoint in time");
    }

    async loadDisc(image) {
        const data = await fdc.load(image);
        this.processor.fdc.loadDisc(0, fdc.discFor(this.processor.fdc, "", data));
    }

    /**
     * Load a disc image from raw data (Uint8Array or Buffer).
     * @param {Uint8Array|Buffer} data - raw disc image bytes
     */
    loadDiscData(data) {
        this.processor.fdc.loadDisc(0, fdc.discFor(this.processor.fdc, "", data));
    }

    /**
     * Reset the machine.
     * @param {boolean} hard - true for power-on reset, false for soft reset
     */
    reset(hard) {
        this.processor.reset(hard);
    }

    /**
     * Take a snapshot of the entire machine state (CPU, RAM, SWRAM,
     * VIAs, video, FDC, etc). Returns an opaque state object that
     * can be passed to restore().
     */
    snapshot({ includeRoms = true } = {}) {
        return this.processor.snapshotState({ includeRoms });
    }

    /**
     * Restore a previously saved snapshot. The machine will be in
     * exactly the state it was when snapshot() was called.
     */
    restore(state) {
        this.processor.restoreState(state);
    }

    async loadBasic(source) {
        const tokeniser = await Tokeniser.create();
        const tokenised = tokeniser.tokenise(source);
        // TODO: dedupe from main.js
        const page = this.readbyte(0x18) << 8;
        for (let i = 0; i < tokenised.length; ++i) {
            this.writebyte(page + i, tokenised.charCodeAt(i));
        }
        // Set VARTOP (0x12/3) and TOP(0x02/3)
        const end = page + tokenised.length;
        const endLow = end & 0xff;
        const endHigh = (end >>> 8) & 0xff;
        this.writebyte(0x02, endLow);
        this.writebyte(0x03, endHigh);
        this.writebyte(0x12, endLow);
        this.writebyte(0x13, endHigh);
    }

    /**
     * Convert an ASCII character to a {code, shift} pair for the BBC keyboard.
     */
    _charToKey(ch) {
        switch (ch) {
            case "\n":
            case "\r":
                return { code: 13, shift: false };
            case '"':
                return { code: utils.keyCodes.K2, shift: true };
            case "*":
                return { code: utils.keyCodes.APOSTROPHE, shift: true };
            case "!":
                return { code: utils.keyCodes.K1, shift: true };
            case ".":
                return { code: utils.keyCodes.PERIOD, shift: false };
            case ";":
                return { code: utils.keyCodes.SEMICOLON, shift: false };
            case ":":
                return { code: utils.keyCodes.APOSTROPHE, shift: false };
            case ",":
                return { code: utils.keyCodes.COMMA, shift: false };
            case "&":
                return { code: utils.keyCodes.K6, shift: true };
            case " ":
                return { code: utils.keyCodes.SPACE, shift: false };
            case "-":
                return { code: utils.keyCodes.MINUS, shift: false };
            case "=":
                return { code: utils.keyCodes.MINUS, shift: true };
            case "+":
                return { code: utils.keyCodes.SEMICOLON, shift: true };
            case "^":
                return { code: utils.keyCodes.EQUALS, shift: false };
            case "~":
                return { code: utils.keyCodes.EQUALS, shift: true };
            case "[":
                return { code: utils.keyCodes.LEFT_SQUARE_BRACKET, shift: false };
            case "]":
                return { code: utils.keyCodes.RIGHT_SQUARE_BRACKET, shift: false };
            case "{":
                return { code: utils.keyCodes.LEFT_SQUARE_BRACKET, shift: true };
            case "}":
                return { code: utils.keyCodes.HASH, shift: true };
            case "\\":
                return { code: utils.keyCodes.BACKSLASH, shift: false };
            case "/":
                return { code: utils.keyCodes.SLASH, shift: false };
            case "?":
                return { code: utils.keyCodes.SLASH, shift: true };
            case "<":
                return { code: utils.keyCodes.COMMA, shift: true };
            case ">":
                return { code: utils.keyCodes.PERIOD, shift: true };
            case "(":
                return { code: utils.keyCodes.K8, shift: true };
            case ")":
                return { code: utils.keyCodes.K9, shift: true };
            case "@":
                return { code: utils.keyCodes.BACK_QUOTE, shift: false };
            case "#":
                return { code: utils.keyCodes.K3, shift: true };
            case "$":
                return { code: utils.keyCodes.K4, shift: true };
            case "%":
                return { code: utils.keyCodes.K5, shift: true };
            default: {
                const upper = ch.toUpperCase();
                const isLetter = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
                if (isLetter) {
                    const wantUpper = ch >= "A" && ch <= "Z";
                    const capsOn = this.processor.sysvia.capsLockLight;
                    // CAPS LOCK on: unshifted = upper, shifted = lower
                    // CAPS LOCK off: unshifted = lower, shifted = upper
                    const needShift = capsOn ? !wantUpper : wantUpper;
                    return { code: upper.charCodeAt(0), shift: needShift };
                }
                return { code: ch.charCodeAt(0), shift: false };
            }
        }
    }

    /**
     * Type text by installing a debugInstruction hook that presses/releases
     * keys at timed intervals during CPU execution.  The hook persists across
     * runFor calls, so breakpoints naturally coexist: if a breakpoint halts
     * execution mid-typing, the remaining characters are typed when execution
     * resumes.
     */
    async type(text) {
        if (this.model.isAtom) {
            return this._typeAtom(text);
        }
        const fullText = text + "\n"; // append RETURN
        const keys = fullText.split("").map((ch) => this._charToKey(ch));
        const holdCycles = 40000;
        let index = 0;
        let phase = "idle"; // "idle" → "down" → "idle"
        let nextEventCycle = 0;
        let done = false;

        const currentCycle = () => this.processor.cycleSeconds * 2000000 + this.processor.currentCycles;

        const hook = this.processor.debugInstruction.add(() => {
            if (currentCycle() < nextEventCycle) return;

            if (phase === "down") {
                // Release current key
                const key = keys[index];
                this.processor.sysvia.keyUp(key.code);
                if (key.shift) this.processor.sysvia.keyUp(16);
                index++;
                phase = "idle";
                nextEventCycle = currentCycle() + holdCycles;
                return;
            }

            // phase === "idle"
            if (index >= keys.length) {
                hook.remove();
                done = true;
                return;
            }

            // Press next key
            const key = keys[index];
            if (key.shift) this.processor.sysvia.keyDown(16);
            this.processor.sysvia.keyDown(key.code);
            phase = "down";
            nextEventCycle = currentCycle() + holdCycles;
        });

        // Drive execution in chunks until all characters are typed or
        // a breakpoint halts the CPU.
        while (!done) {
            const stopped = await this.runFor(holdCycles);
            if (stopped) break;
        }
    }

    /** Type text on the Atom using its key mapping and PPIA interface. */
    async _typeAtom(text) {
        // stringToATOMKeys returns a flat array of [col, row] pairs.
        // SHIFT is held across multiple characters; LOCK is tapped to
        // toggle the ROM's internal caps lock state.
        const keySequence = utils_atom.stringToATOMKeys(text + "\n");
        const ppia = this.processor.atomppia;
        const holdCycles = 80000; // Atom at 1 MHz needs longer hold than BBC at 2 MHz
        const SHIFT = utils_atom.ATOM.SHIFT;

        let index = 0;
        let phase = "idle";
        let nextEventCycle = 0;
        let done = false;
        let shiftHeld = false;

        const currentCycle = () => this.processor.cycleSeconds * 1000000 + this.processor.currentCycles;

        const isShift = (entry) => entry[0] === SHIFT[0] && entry[1] === SHIFT[1];

        const hook = this.processor.debugInstruction.add(() => {
            if (currentCycle() < nextEventCycle) return;

            if (phase === "down") {
                const entry = keySequence[index];
                if (!isShift(entry)) {
                    ppia.keyUpRaw(entry);
                }
                index++;
                phase = "idle";
                nextEventCycle = currentCycle() + holdCycles;
                return;
            }

            if (index >= keySequence.length) {
                if (shiftHeld) ppia.keyUpRaw(SHIFT);
                hook.remove();
                done = true;
                return;
            }

            const entry = keySequence[index];
            if (isShift(entry)) {
                if (shiftHeld) {
                    ppia.keyUpRaw(SHIFT);
                    shiftHeld = false;
                } else {
                    ppia.keyDownRaw(SHIFT);
                    shiftHeld = true;
                }
                index++;
                nextEventCycle = currentCycle() + holdCycles;
            } else {
                ppia.keyDownRaw(entry);
                phase = "down";
                nextEventCycle = currentCycle() + holdCycles;
            }
        });

        while (!done) {
            const stopped = await this.runFor(holdCycles);
            if (stopped) {
                hook.remove();
                if (shiftHeld) ppia.keyUpRaw(SHIFT);
                break;
            }
        }
    }

    /**
     * Press a key on the keyboard.
     * @param {number} code - key code (BBC keyCode or Atom raw key)
     */
    keyDown(code) {
        this._keyInterface.keyDown(code);
    }

    /**
     * Release a key on the keyboard.
     * @param {number} code - key code
     */
    keyUp(code) {
        this._keyInterface.keyUp(code);
    }

    /**
     * Load a ROM image directly into a sideways RAM slot.
     * @param {number} slot - slot number (0-15, typically 4-7 for SWRAM)
     * @param {Uint8Array|Buffer} data - ROM data (up to 16384 bytes)
     */
    loadSidewaysRam(slot, data) {
        const offset = this.processor.romOffset + slot * 16384;
        for (let i = 0; i < data.length && i < 16384; i++) {
            this.processor.ramRomOs[offset + i] = data[i];
        }
    }

    writebyte(addr, val) {
        this.processor.writemem(addr, val);
    }

    readbyte(addr) {
        return this.processor.readmem(addr);
    }

    readword(addr) {
        return this.readbyte(addr) | (this.readbyte(addr + 1) << 8);
    }

    captureText(onElement) {
        const attributes = {
            x: 0,
            y: 0,
            text: "",
            foreground: 7,
            background: 0,
            mode: 7,
        };
        let currentText = "";
        let params = [];
        let nextN = 0;
        let vduProc = null;

        function flush() {
            if (currentText.length) {
                attributes.text = currentText;
                onElement(attributes);
                attributes.x += currentText.length; // Approximately...anyway
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
                case 10:
                    attributes.y++;
                    break;
                case 12: // CLS
                    attributes.x = 0;
                    attributes.y = 0;
                    break;
                case 13:
                    attributes.x = 0;
                    break;
                case 17: // Text colour
                    nextN = 1;
                    vduProc = function (params) {
                        if (params[0] & 0x80) attributes.background = params[0] & 0xf;
                        else attributes.foreground = params[0] & 0xf;
                    };
                    break;
                case 18: // GCOL
                    nextN = 2;
                    break;
                case 19: // logical colour
                    nextN = 5;
                    break;
                case 22: // mode
                    nextN = 1;
                    vduProc = function (params) {
                        attributes.mode = params[0];
                        attributes.x = 0;
                        attributes.y = 0;
                    };
                    break;
                case 25: // plot
                    nextN = 5;
                    break;
                case 28: // text window
                    nextN = 4;
                    break;
                case 29: // origin
                    nextN = 4;
                    break;
                case 31: // text location
                    nextN = 2;
                    vduProc = function (params) {
                        attributes.x = params[0];
                        attributes.y = params[1];
                    };
            }
            if (c >= 32 && c < 0x7f) {
                currentText += String.fromCharCode(c);
            } else flush();
            return false;
        }

        const wrchv = this.readword(0x20e);
        this.processor.debugInstruction.add((addr) => {
            if (addr === wrchv) onChar(this.processor.a);
            return false;
        });
    }
}
