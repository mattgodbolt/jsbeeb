import { installBasic } from "./basic-loader.js";
import * as fdc from "./fdc.js";
import { fake6502 } from "./fake6502.js";
import { findModel } from "./models.js";
import assert from "assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Tokeniser from "./basic-tokenise.js";
import { VduTextCapture } from "./vdu-capture.js";
import { setNodeBasePath } from "./loader.js";
import { Typist } from "./typist.js";

const MaxCyclesPerIter = 100 * 1000;
const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class TestMachine {
    constructor(model, opts) {
        model = model || "B-DFS1.2";
        this.model = findModel(model);
        if (!this.model) throw new Error(`Unknown model "${model}"`);
        this.processor = fake6502(this.model, opts || {});
        this.typist = new Typist(this.processor);
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

    /** Emulated cycles since power-on, undoing the per-second rebasing execute() applies. */
    get elapsedCycles() {
        const cpu = this.processor;
        return cpu.cycleSeconds * this.model.cyclesPerSecond + cpu.currentCycles;
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
     * Types the text and a RETURN at the machine, running the CPU until the
     * last key is up. The keys arrive from the scheduler, so a breakpoint that
     * stops the CPU part way leaves the rest to be typed when it runs again.
     */
    async type(text) {
        const lines = text.replace(/\r\n?/g, "\n");
        this.typist.type(this.model.stringToKeys(lines + "\n"), true);
        while (this.typist.isTyping) {
            const stopped = await this.runFor(MaxCyclesPerIter);
            if (stopped) break;
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
