import { RomBankBytes } from "./6502.js";
import { installBasic } from "./basic-loader.js";
import * as fdc from "./fdc.js";
import { fake6502 } from "./fake6502.js";
import { findModel } from "./models.js";
import assert from "assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import * as Tokeniser from "./basic-tokenise.js";
import { VduTextCapture } from "./vdu-capture.js";
import { loadData, setNodeBasePath } from "./loader.js";
import { Typist } from "./typist.js";
import { keyCodes } from "./keymap.js";
import { cycleCount } from "./lockstep.js";

export const MaxCyclesPerIter = 100 * 1000;
const VblankSearchCycles = 10 * 1000 * 1000;
export const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HostKeyCodes = new Set(Object.values(keyCodes));

function requireKnownKeyCode(method, code) {
    if (typeof code === "number") {
        throw new Error(
            `${method}: ${code} is a numeric key code; since 2.0 keys are named by physical position, ` +
                `as KeyboardEvent.code names them, e.g. "ShiftLeft". See keyCodes in keymap.js`,
        );
    }
    if (!HostKeyCodes.has(code)) {
        const shown = typeof code === "string" ? JSON.stringify(code) : inspect(code);
        throw new Error(
            `${method}: ${shown} is not a key jsbeeb knows; keys are named ` +
                `by physical position, as KeyboardEvent.code names them, e.g. "ShiftLeft" or "KeyA". ` +
                `See keyCodes in keymap.js`,
        );
    }
}

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

    /**
     * Run for `cycles` emulated cycles, or until something stops the CPU.
     * Resolves true if it was stopped short. Rejects if a hook or device throws,
     * leaving the cycle target where the run stopped.
     */
    runFor(cycles) {
        let left = cycles;
        let stopped = false;
        const cpu = this.processor;
        return new Promise((resolve, reject) => {
            const runAnIter = () => {
                const todo = Math.max(0, Math.min(left, MaxCyclesPerIter));
                if (todo) {
                    try {
                        stopped = !cpu.execute(todo);
                    } catch (e) {
                        cpu.targetCycles = cpu.currentCycles;
                        reject(e);
                        return;
                    }
                    left -= todo;
                }
                // execute() adds each request to a running targetCycles, so budget
                // left unspent by an early stop would silently lengthen the next run.
                if (stopped) cpu.targetCycles = cpu.currentCycles;
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
        return cycleCount(this.processor);
    }

    async runUntilVblank() {
        const { vsyncAddress } = this.model;
        if (vsyncAddress === null) throw new Error(`runUntilVblank does not know the ${this.model.name} OS`);
        await this._runUntilAddress(vsyncAddress, VblankSearchCycles);
    }

    async runUntilInput(secs) {
        console.log("Running until keyboard input requested");
        await this.runUntilAddress(this.model.idleAddress, secs);
        return this.runFor(10 * 1000);
    }

    /** The sideways bank paged in at &8000 to &BFFF. */
    get pagedBank() {
        return this.processor.pagedBank;
    }

    /** Whether sideways `bank` is paged in at `address`; see the CPU's isBankPagedAt. */
    isBankPagedAt(bank, address) {
        return this.processor.isBankPagedAt(bank, address);
    }

    /**
     * Run until the PC reaches `targetAddr`, with sideways `bank` paged in if
     * one is given, or throw after `secs` of emulated time.
     */
    async runUntilAddress(targetAddr, secs, { bank } = {}) {
        if (!secs) secs = 120;
        await this._runUntilAddress(targetAddr, secs * this.model.cyclesPerSecond, { bank });
    }

    /**
     * Stop any run when the CPU executes, reads or writes `address`, only
     * while sideways `bank` is paged in there if one is given, calling
     * `onHit` first with the byte read or written. An execute breakpoint
     * never fires for the instruction the CPU resumes at after a stop.
     * Returns a handle whose `remove()` ends the watch.
     * @param {"execute"|"read"|"write"|"access"} type
     * @param {number} address
     * @param {{bank: (number|undefined)}} opts
     * @param {function(number=): void} onHit
     */
    addBreakpoint(type, address, { bank }, onHit) {
        const { breakpoints } = this.processor;
        const id = breakpoints.add({
            kind: type,
            start: address,
            bank,
            owner: "TestMachine",
            onHit: ({ value }) => onHit(value),
        });
        return { remove: () => breakpoints.remove(id) };
    }

    async _runUntilAddress(address, cycles, { bank } = {}) {
        let hit = false;
        const hook = this.addBreakpoint("execute", address, { bank }, () => {
            hit = true;
        });
        try {
            await this.runFor(cycles);
        } finally {
            hook.remove();
        }
        assert(hit, "did not hit appropriate breakpoint in time");
    }

    async loadDisc(image) {
        const data = await loadData(image);
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
     * Types the text at the machine, then a RETURN unless it already ends in
     * one, running the CPU until the last key is up. The keys arrive from the
     * scheduler, so a breakpoint that stops the CPU part way leaves the rest to
     * be typed when it runs again.
     */
    async type(text) {
        const lines = text.replace(/\r\n?/g, "\n");
        const entered = lines.endsWith("\n") ? lines : `${lines}\n`;
        this.typist.type(this.model.stringToKeys(entered), true);
        while (this.typist.isTyping) {
            const stopped = await this.runFor(MaxCyclesPerIter);
            if (stopped) break;
        }
    }

    /**
     * Press a key on the keyboard. Throws on a code that is not in `keyCodes`.
     * @param {string} code - the host key by physical position, as `keyCodes` in keymap.js names it
     * @param {boolean} [shiftDown] - whether the host's shift is held, which only a natural layout maps on
     */
    keyDown(code, shiftDown = false) {
        requireKnownKeyCode("keyDown", code);
        this.processor.keyboardInterface.keyDown(code, shiftDown);
    }

    /**
     * Release a key on the keyboard. Throws on a code that is not in `keyCodes`.
     * @param {string} code - the host key by physical position
     */
    keyUp(code) {
        requireKnownKeyCode("keyUp", code);
        this.processor.keyboardInterface.keyUp(code);
    }

    /**
     * Load a ROM image directly into a sideways RAM slot.
     * @param {number} slot - slot number (0-15, typically 4-7 for SWRAM)
     * @param {Uint8Array|Buffer} data - ROM data (up to one 16KB bank)
     */
    loadSidewaysRam(slot, data) {
        this.processor.romBank(slot).set(data.subarray(0, RomBankBytes));
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
