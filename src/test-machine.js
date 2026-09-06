import { installBasic } from "./basic-loader.js";
import * as fdc from "./fdc.js";
import { fake6502 } from "./fake6502.js";
import { findModel } from "./models.js";
import assert from "assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as utils_atom from "./keymap-atom.js";
import * as Tokeniser from "./basic-tokenise.js";
import { VduTextCapture } from "./vdu-capture.js";
import { setNodeBasePath } from "./loader.js";
import { keyCodes } from "./keymap.js";

const MaxCyclesPerIter = 100 * 1000;
const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class TestMachine {
    constructor(model, opts) {
        model = model || "B-DFS1.2";
        this.model = findModel(model);
        if (!this.model) throw new Error(`Unknown model "${model}"`);
        this.processor = fake6502(this.model, opts || {});
        this._capturedChars = [];
        this._captureHookInstalled = false;
    }

    /** The keyboard interface for this machine (SysVia for BBC, PPIA for Atom). */
    get _keyInterface() {
        return this.processor.keyboardInterface;
    }

    async initialise() {
        setNodeBasePath(RepoRoot);
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
     * Calls `listener` with each character the machine sends to the VDU, by
     * watching the write-character vector (WRCHV, $020E on the BBC and $0208 on
     * the Atom) as the OS or a program leaves it. Returns a function that stops
     * listening.
     */
    onVduChar(listener) {
        if (!this._vduListeners) {
            this._vduListeners = [];
            const cpu = this.processor;
            const ram = cpu.ramRomOs;
            const wrchvAddr = this.model.wrchvAddress;
            cpu.debugInstruction.add((addr) => {
                if (addr === (ram[wrchvAddr] | (ram[wrchvAddr + 1] << 8))) {
                    for (const listen of this._vduListeners) listen(cpu.a);
                }
                return false;
            });
        }
        this._vduListeners.push(listener);
        return () => {
            this._vduListeners = this._vduListeners.filter((other) => other !== listener);
        };
    }

    /** Accumulates every character sent to the VDU for drainText(); safe to call more than once. */
    startCapture() {
        if (this._captureHookInstalled) return;
        this._captureHookInstalled = true;
        this.onVduChar((c) => this._capturedChars.push(c));
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
                // Not truthiness: a negative or NaN request clamps todo to zero,
                // so left would never move and the loop never end.
                if (left > 0 && !stopped) {
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

    async runUntilFlashHidden() {
        const teletext = this.processor.video.teletext;
        for (let i = 0; i < 100; i++) {
            if (teletext.hideFlashing) return;
            await this.runFor(40000);
        }
        throw new Error("Flashing text did not reach its hidden phase in time");
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
        const idleAddr = this.model.idleAddress;
        let hit = false;
        const hook = this.processor.debugInstruction.add((addr) => {
            if (addr === idleAddr) {
                hit = true;
                return true;
            }
        });
        await this.runFor(secs * this.model.cyclesPerSecond);
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
        await this.runFor(secs * this.model.cyclesPerSecond);
        hook.remove();
        assert(hit, "did not hit appropriate breakpoint in time");
    }

    async loadDisc(image) {
        const data = await fdc.load(image);
        this.processor.fdc.loadDisc(0, fdc.discFor(image, data));
    }

    /**
     * Load a disc image from raw data (Uint8Array or Buffer).
     * @param {Uint8Array|Buffer} data - raw disc image bytes
     */
    loadDiscData(data) {
        this.processor.fdc.loadDisc(0, fdc.discFor("", data));
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
        installBasic(tokenised, {
            readByte: (addr) => this.readbyte(addr),
            writeByte: (addr, value) => this.writebyte(addr, value),
        });
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
                return { code: keyCodes.K2, shift: true };
            case "*":
                return { code: keyCodes.APOSTROPHE, shift: true };
            case "!":
                return { code: keyCodes.K1, shift: true };
            case ".":
                return { code: keyCodes.PERIOD, shift: false };
            case ";":
                return { code: keyCodes.SEMICOLON, shift: false };
            case ":":
                return { code: keyCodes.APOSTROPHE, shift: false };
            case ",":
                return { code: keyCodes.COMMA, shift: false };
            case "&":
                return { code: keyCodes.K6, shift: true };
            case " ":
                return { code: keyCodes.SPACE, shift: false };
            case "-":
                return { code: keyCodes.MINUS, shift: false };
            case "=":
                return { code: keyCodes.MINUS, shift: true };
            case "+":
                return { code: keyCodes.SEMICOLON, shift: true };
            case "^":
                return { code: keyCodes.EQUALS, shift: false };
            case "~":
                return { code: keyCodes.EQUALS, shift: true };
            case "[":
                return { code: keyCodes.LEFT_SQUARE_BRACKET, shift: false };
            case "]":
                return { code: keyCodes.RIGHT_SQUARE_BRACKET, shift: false };
            case "{":
                return { code: keyCodes.LEFT_SQUARE_BRACKET, shift: true };
            case "}":
                return { code: keyCodes.HASH, shift: true };
            case "\\":
                return { code: keyCodes.BACKSLASH, shift: false };
            case "/":
                return { code: keyCodes.SLASH, shift: false };
            case "?":
                return { code: keyCodes.SLASH, shift: true };
            case "<":
                return { code: keyCodes.COMMA, shift: true };
            case ">":
                return { code: keyCodes.PERIOD, shift: true };
            case "(":
                return { code: keyCodes.K8, shift: true };
            case ")":
                return { code: keyCodes.K9, shift: true };
            case "@":
                return { code: keyCodes.BACK_QUOTE, shift: false };
            case "#":
                return { code: keyCodes.K3, shift: true };
            case "$":
                return { code: keyCodes.K4, shift: true };
            case "%":
                return { code: keyCodes.K5, shift: true };
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
        // Key hold is counted in CPU cycles, so scale it to keep the hold constant in
        // real time: the OS scans the keyboard on a peripheral-rate interrupt.
        const holdCycles = (40000 * this.processor.cpuMultiplier) | 0;
        let index = 0;
        let phase = "idle"; // "idle" → "down" → "idle"
        let nextEventCycle = 0;
        let done = false;

        const currentCycle = () =>
            this.processor.cycleSeconds * this.model.cyclesPerSecond + this.processor.currentCycles;

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
        const holdCycles = (80000 * this.processor.cpuMultiplier) | 0; // Atom at 1 MHz needs longer hold than BBC at 2 MHz
        const SHIFT = utils_atom.ATOM.SHIFT;

        let index = 0;
        let phase = "idle";
        let nextEventCycle = 0;
        let done = false;
        let shiftHeld = false;

        const currentCycle = () =>
            this.processor.cycleSeconds * this.model.cyclesPerSecond + this.processor.currentCycles;

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

    /**
     * Decodes the machine's VDU output into text elements for `onElement`
     * until the returned capture's `stop()` is called; see VduTextCapture.
     */
    captureText(onElement) {
        const capture = new VduTextCapture(onElement, { isAtom: this.model.isAtom });
        capture.stop = this.onVduChar((c) => capture.onChar(c));
        return capture;
    }
}
