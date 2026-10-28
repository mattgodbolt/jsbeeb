/**
 * MachineSession - wraps jsbeeb's TestMachine with:
 *   - real Video framebuffer (so screenshots work)
 *   - accumulated text output between calls
 *   - clean lifecycle (boot, interact, screenshot, destroy)
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { TestMachine } from "./test-machine.js";
import { VduTextCapture } from "./vdu-capture.js";
import { InstrumentedSoundChip, FakeSoundChip } from "./soundchip.js";

// Resolve the jsbeeb package root from our own location (src/machine-session.js
// → go up one level).  Passed to setNodeBasePath() so the ROM loader resolves
// files relative to this package regardless of the calling process's cwd.
const _jsbeebRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
import * as fdc from "./fdc.js";
import { loadTapeFromData } from "./tapes.js";
import { MediaResolver } from "./media-resolver.js";
import { StairwayToHell } from "./sth.js";
import { BitshiftersArchive } from "./bitshifters.js";
import { BbcDiscArchive } from "./bbcdiscs.js";
import { Video } from "./video.js";
import { findModel } from "./models.js";
import { NumRomBanks } from "./6502.js";
import { setNodeBasePath } from "./loader.js";

// BBC framebuffer is 1024×625 pixels
const FB_WIDTH = 1024;
const FB_HEIGHT = 625;

// Bit X of ACCCON: shadow RAM in place of main at &3000 to &7FFF.
const AccconShadowBit = 4;

// Where the MOS keeps its read and write offsets into the keyboard buffer (buffer 0), which is empty when they
// are equal.
const KeyboardBufferOffsets = { read: 0x2d8, write: 0x2e1 };
const MasterKeyboardBufferOffsets = { read: 0x2d7, write: 0x2e0 };

// Five times a frame, so only a machine that has stopped painting hits it.
const BackstopSecondsPerFrame = 0.1;

const BootDrive = 0;
// Drive 0 starts 2 frames after a soft autoboot on the DFS models, and 15 (B) to 36 (Master) after a power-on one;
// four times the slowest leaves room for slower boot ROMs.
export const AutobootMaxFrames = 150;
// The MOS offers each sideways ROM its service calls at &8003 with the reason in A; reason 3 is auto-boot,
// with Y zero when the MOS wants the filing system to boot.
const ServiceEntry = 0x8003;
const ServiceAutoboot = 3;

export class MachineSession {
    /**
     * @param {string} modelName - e.g. "B-DFS1.2", "Master"
     * @param {Object} [opts]
     * @param {string} [opts.discImage] - path to an .ssd or .dsd disc image to put in drive 0; it is loaded,
     *   not booted, so follow with autoboot() to SHIFT+BREAK it
     * @param {boolean} [opts.tube] - attach a 65C02 second processor (Tube co-processor)
     * @param {number} [opts.cpuMultiplier] - run the CPU this many times faster than the peripherals
     * @param {boolean} [opts.hasTeletextAdaptor] - fit the Acorn teletext adaptor
     * @param {boolean} [opts.hasVideoNula] - fit a VideoNuLA in place of the video ULA
     * @param {boolean} [opts.econet] - fit Econet, with a file server on the network, and on a Master the ANFS
     *   ROM, as the web page does
     * @param {number} [opts.stationId=101] - the Econet station number, 1 to 253
     * @param {string[]} [opts.extraRoms] - sideways ROMs for the free banks, highest first, as the page's `rom=`
     *   takes them: a name or path under roms/, a `file:` or `http(s):` URL, or a `github:` reference
     * @param {{bank: number, rom: string}[]} [opts.bankRoms] - sideways ROMs for the banks they name, as the page's
     *   `rom.N=`; initialise() throws for a bank the model has no socket for, one the model or its fittings fill,
     *   or one named twice
     */
    constructor(modelName = "B-DFS1.2", opts = {}) {
        this.modelName = modelName;
        this._opts = opts;

        // _completeFb8 is a snapshot taken at paint time (the equivalent of the browser canvas)
        // and is what screenshot() reads from, always a complete frame, never mid-render.
        this._completeFb8 = new Uint8Array(FB_WIDTH * FB_HEIGHT * 4);
        this._lastPaint = { minx: 0, miny: 0, maxx: FB_WIDTH, maxy: FB_HEIGHT };
        this._frameDirty = false;
        this._frameCount = 0;
        this._stopAtFrame = Infinity;

        // Create a real Video instance so we get pixel output
        const modelObj = findModel(modelName);
        this._isAtom = modelObj.isAtom;
        this._keyboardBufferOffsets = modelObj.isMaster ? MasterKeyboardBufferOffsets : KeyboardBufferOffsets;
        const session = this;
        this._video = new Video(
            modelObj.isMaster,
            FB_WIDTH * FB_HEIGHT,
            function (minx, miny, maxx, maxy) {
                session._lastPaint = { minx, miny, maxx, maxy };
                session._frameDirty = true;
                // Snapshot the complete frame now, before clearPaintBuffer() wipes it.
                // This mirrors what the browser does: paint_ext fires → canvas updated → fb32 cleared.
                const { fb32 } = this;
                session._completeFb8.set(new Uint8Array(fb32.buffer, fb32.byteOffset, fb32.byteLength));
                session._frameCount++;
                if (session._frameCount >= session._stopAtFrame) session._machine.processor.stop();
            },
            { isAtom: modelObj.isAtom, hasVideoNula: opts.hasVideoNula },
        );

        // Use a real (instrumented) sound chip so we can read registers and capture writes.
        // Atom models use AtomSoundChip which has a different interface (speakerGenerator,
        // toneGenerator); FakeSoundChip provides compatible no-op stubs for headless mode.
        this._soundChip = modelObj.isAtom ? new FakeSoundChip() : new InstrumentedSoundChip();

        // TestMachine forwards these to fake6502
        this._machine = new TestMachine(modelName, {
            video: this._video,
            soundChip: this._soundChip,
            tube: opts.tube,
            cpuMultiplier: opts.cpuMultiplier,
            hasTeletextAdaptor: opts.hasTeletextAdaptor,
            econet: opts.econet,
            stationId: opts.stationId,
            extraRoms: opts.extraRoms,
            bankRoms: opts.bankRoms,
        });

        // Accumulated VDU text output, drained by callers
        this._pendingOutput = [];
        this._capture = new VduTextCapture((element) => this._pendingOutput.push(element), { isAtom: this._isAtom });

        // Breakpoint management, with persistent hooks that survive across run calls
        this._breakpoints = new Map(); // id → { hook, type, address, bank, hit, value }
        this._nextBreakpointId = 1;
    }

    /** Load ROMs and hardware; call once before anything else */
    async initialise() {
        setNodeBasePath(_jsbeebRoot);
        await this._machine.initialise();
        if (this._opts.discImage) {
            this.loadDisc(this._opts.discImage);
        }
        this._machine.onVduChar((c) => this._capture.onChar(c));
    }

    /**
     * Boot the machine (run until the BASIC prompt).
     * Returns captured boot-screen text (the OS banner etc.).
     */
    async boot(timeoutSecs = 30) {
        await this._machine.runUntilInput(timeoutSecs);
        return this.drainOutput();
    }

    get _keyboard() {
        return this._machine.processor.keyboardInterface;
    }

    /**
     * The keyboard is the typist's until everything from type() has been
     * delivered, and a key pressed meanwhile would be silently dropped.
     */
    _requireKeyboard() {
        if (this.typingPending) {
            throw new Error(
                "Text from type() is still being typed: await type(), or if a breakpoint stopped it " +
                    "run the machine on to finish it, or cancelTyping() first",
            );
        }
    }

    /**
     * Press a host key by its physical position, as `KeyboardEvent.code` names it:
     * "KeyA", "Digit1", "ShiftLeft", "NumpadEnter". The `keyCodes` table in keymap.js
     * gives jsbeeb's own name for each, and a code not in it throws.
     */
    keyDown(code, shiftDown = false) {
        this._requireKeyboard();
        this._machine.keyDown(code, shiftDown);
    }

    /** Release a host key, by the same `KeyboardEvent.code` name. */
    keyUp(code) {
        this._requireKeyboard();
        this._machine.keyUp(code);
    }

    /**
     * Press a key by its place in the keyboard matrix, as the model's key
     * table (BBC or ATOM in the keymaps) gives it, with no host key map in
     * between: a game reading the matrix sees exactly this key.
     * @param {[number, number]} colRow
     */
    keyDownRaw(colRow) {
        this._requireKeyboard();
        this._keyboard.keyDownRaw(colRow);
    }

    /**
     * Release a key pressed by matrix position.
     * @param {[number, number]} colRow
     */
    keyUpRaw(colRow) {
        this._requireKeyboard();
        this._keyboard.keyUpRaw(colRow);
    }

    /**
     * Every key currently down, as matrix positions keyDownRaw takes.
     * @returns {Array<[number, number]>}
     */
    heldKeys() {
        const held = [];
        this._keyboard.keys.forEach((column, col) => {
            column.forEach((down, row) => {
                if (down) held.push([col, row]);
            });
        });
        return held;
    }

    /** Whether text from type() is still to be delivered, which a breakpoint stopping the run leaves behind. */
    get typingPending() {
        return this._machine.typist.isTyping;
    }

    /** Drop any text from type() still to be delivered, and give the keyboard back. */
    cancelTyping() {
        this._machine.typist.cancel();
    }

    /** Empty the MOS's keyboard buffer; unlike OSBYTE 21, a soft key's expansion still to come is left. */
    flushKeyboardBuffer() {
        if (this._isAtom) throw new Error("flushKeyboardBuffer: the Atom's OS has no keyboard buffer");
        const { read, write } = this._keyboardBufferOffsets;
        this.writeMemory(read, this.readMemory(write, 1));
    }

    /** Release every key, and drop any typing still pending, so the keyboard is in a known state. */
    releaseAllKeys() {
        this.cancelTyping();
        this._keyboard.clearKeys();
    }

    /**
     * Reset the machine.
     * @param {boolean} [hard=true] - true for power-on reset, false for soft reset
     */
    reset(hard = true) {
        this._machine.processor.reset(hard);
        this._pendingOutput = [];
    }

    /**
     * SHIFT+BREAK: reset with SHIFT held, keeping it down until the MOS has
     * asked the filing system to boot and drive 0's motor has started, then
     * let it go. The boot is under way but not finished; run the machine on
     * to see it.
     *
     * Throws if the drive is empty, a key or typing is pending, or on the
     * Atom, all before the reset. After it, throws if the MOS did not ask for
     * a boot, as on a machine configured to boot on a plain BREAK, where SHIFT
     * stops it; or if drive 0 never starts, as when Econet takes the boot.
     * Either way SHIFT is up and the machine is left where it stopped. It
     * cannot tell whether the filing system can read the disc: a DFS disc on
     * a model whose boot goes to ADFS spins the drive and does not boot.
     *
     * `completed` is false if a breakpoint stopped the machine first, or the
     * machine stopped painting frames, with SHIFT released all the same. Running on then boots
     * if `bootRequested` is true. False only means the MOS had not asked yet:
     * whether it still boots depends on when that MOS reads SHIFT, and on the
     * B and the Master, stopped as late as the banner, it does not.
     *
     * @param {Object} [opts]
     * @param {boolean} [opts.hard=true] - power-on reset rather than BREAK
     * @returns {Promise<{framesHeld: number, bootRequested: boolean, completed: boolean}>}
     */
    async autoboot({ hard = true } = {}) {
        this._requireAutoboot();
        const cpu = this._machine.processor;
        const drive = cpu.fdc.drives[BootDrive];
        if (!drive.disc) throw new Error(`autoboot: there is no disc in drive ${BootDrive}`);

        let bootRequested;
        let driveStarted = false;
        let framesRun;
        const onStart = () => {
            if (!bootRequested) return;
            driveStarted = true;
            cpu.stop();
        };
        let serviceHook;
        try {
            serviceHook = cpu.debugInstruction.add((pc) => {
                if (pc !== ServiceEntry || cpu.a !== ServiceAutoboot || bootRequested !== undefined) return;
                bootRequested = cpu.y === 0;
                if (!bootRequested) cpu.stop();
            });
            drive.addEventListener("startSpinning", onStart);
            this._keyboard.keyDownRaw(cpu.model.keys.SHIFT);
            this.reset(hard);
            ({ framesRun } = await this.runFrames(AutobootMaxFrames));
        } finally {
            this._keyboard.keyUpRaw(cpu.model.keys.SHIFT);
            drive.removeEventListener("startSpinning", onStart);
            if (serviceHook) serviceHook.remove();
        }
        if (bootRequested === false) {
            throw new Error(
                "autoboot: the MOS did not ask the filing system to boot; " +
                    "a machine configured to boot on BREAK (*CONFIGURE BOOT, or a B's boot link) takes SHIFT to mean " +
                    "do not boot",
            );
        }
        if (!driveStarted && framesRun >= AutobootMaxFrames) {
            const why = bootRequested ? `drive ${BootDrive} did not start` : "the MOS did not ask for a boot";
            throw new Error(`autoboot: ${why} within ${AutobootMaxFrames} frames of SHIFT+BREAK`);
        }
        return { framesHeld: framesRun, bootRequested: !!bootRequested, completed: driveStarted };
    }

    _requireAutoboot() {
        if (this._isAtom) throw new Error("autoboot: the Atom has no SHIFT+BREAK disc boot");
        this._requireKeyboard();
        if (this.heldKeys().length) throw new Error("autoboot: release the keys held first");
    }

    /**
     * Put a disc in drive 0 and autoboot() it.
     * @param {string} ref - any reference loadDiscImage takes
     * @param {Object} [opts]
     * @param {boolean} [opts.hard=true] - power-on reset rather than BREAK
     * @returns {Promise<{name: string, ignored: string[], framesHeld: number, bootRequested: boolean, completed: boolean}>}
     */
    async bootDisc(ref, { hard = true } = {}) {
        this._requireAutoboot();
        const { name, ignored } = await this.loadDiscImage(ref, BootDrive);
        return { name, ignored, ...(await this.autoboot({ hard })) };
    }

    /**
     * Capture machine state and captured text as an opaque object for restore().
     * Leaves the running session undisturbed.
     *
     * @param {Object} [opts]
     * @param {boolean} [opts.includeRoms=true] - carry the ROM contents too.
     *   Only safe to omit when restoring into a session built from the same
     *   model, which is then left with whatever ROMs it already had.
     */
    snapshot({ includeRoms = true } = {}) {
        return {
            machine: this._machine.snapshot({ includeRoms }),
            pendingOutput: this._pendingOutput.map((element) => ({ ...element })),
            capture: this._capture.snapshot(),
        };
    }

    /**
     * Put back a state from snapshot().  `elapsedCycles` rewinds with the
     * machine; breakpoints belong to the session, not the machine, so they and
     * their hit flags are left alone, and `frameCount` keeps counting the way it
     * does across a hard reset.
     */
    restore(state) {
        this._machine.restore(state.machine);
        this._pendingOutput = state.pendingOutput.map((element) => ({ ...element }));
        this._capture.restore(state.capture);
    }

    /** Tokenise BBC BASIC source and write it into PAGE */
    async loadBasic(source) {
        await this._machine.loadBasic(source);
    }

    /**
     * Type `text`, then a RETURN unless it already ends in one, running the
     * machine until the last key is up. That says nothing about the line
     * itself: the run carries on past the RETURN, so a short command can start
     * and finish before this returns, while a ROM that took over line input
     * may not have read the line yet. Set a breakpoint beforehand to stop
     * inside the command, or runUntilPrompt afterwards to wait for it.
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
     * Run for an exact number of emulated CPU cycles, or until something stops
     * the CPU first: a breakpoint, or the paint runFrames stops at. `completed`
     * is false if it was stopped short. Rejects if a hook or device throws.
     * @returns {Promise<{cyclesRun: number, completed: boolean}>}
     */
    async runFor(cycles) {
        const startCycles = this.elapsedCycles;
        const stopped = await this._machine.runFor(cycles);
        return { cyclesRun: this.elapsedCycles - startCycles, completed: !stopped };
    }

    /** Emulated cycles since power-on */
    get elapsedCycles() {
        return this._machine.elapsedCycles;
    }

    /**
     * Run until `count` more frames have been painted, stopping on the paint
     * itself.  A frame is 40000 cycles interlaced, 39936 not, and whatever a
     * program driving the CRTC makes it, so stepping by cycles instead walks
     * the sample point through the guest's frame.
     *
     * `completed` is false if a breakpoint fired, or the backstop ran out
     * first.
     *
     * @param {number} [count=1] frames to advance
     * @param {Object} [opts]
     * @param {number} [opts.maxCycles] how long to wait on a machine that is not painting
     * @returns {Promise<{framesRun: number, cyclesRun: number, completed: boolean}>}
     */
    async runFrames(count = 1, { maxCycles } = {}) {
        const cpu = this._machine.processor;
        const backstop = maxCycles ?? count * BackstopSecondsPerFrame * cpu.model.cyclesPerSecond;
        const startFrame = this._frameCount;

        this._stopAtFrame = startFrame + count;
        try {
            const { cyclesRun } = await this.runFor(backstop);
            const framesRun = this._frameCount - startFrame;
            return { framesRun, cyclesRun, completed: framesRun >= count };
        } finally {
            this._stopAtFrame = Infinity;
        }
    }

    /** Frames painted since the session was created; a hard reset does not zero it */
    get frameCount() {
        return this._frameCount;
    }

    /**
     * Run until PC reaches targetAddr (like a breakpoint), or throw after timeoutSecs of emulated time.
     * @param {number} addr
     * @param {number} [timeoutSecs=30]
     * @param {Object} [opts]
     * @param {number} [opts.bank] only stop while this sideways bank is paged in at `addr` (on a Master, not
     *     while ANDY is paged over &8000 to &8FFF)
     */
    async runUntilAddress(addr, timeoutSecs = 30, { bank } = {}) {
        requireBank(bank, this._machine.model);
        await this._machine.runUntilAddress(addr, timeoutSecs, { bank });
    }

    /**
     * Add a persistent breakpoint. Returns the breakpoint id.
     * The hook stays active across run calls until removed.
     * When the hook fires, cpu.stop() halts the current runFor.
     * @param {"execute"|"read"|"write"} type
     * @param {number} address
     * @param {Object} [opts]
     * @param {number} [opts.bank] only break while this sideways bank is paged in at `address` (on a Master,
     *     not while ANDY is paged over &8000 to &8FFF)
     * @returns {number} breakpoint id
     */
    addBreakpoint(type, address, { bank } = {}) {
        requireBank(bank, this._machine.model);
        const id = this._nextBreakpointId++;
        const bp = { type, address, bank, hit: false, id, value: undefined };
        bp.hook = this._machine.addBreakpoint(type, address, { bank }, (value) => {
            bp.hit = true;
            bp.value = value;
        });
        this._breakpoints.set(id, bp);
        return id;
    }

    /**
     * Call `fn(pc)` just before each instruction on the host CPU runs, so an instruction the machine stops at is
     * reported before it executes, until the returned function is called. Watching never stops the machine; an
     * exception from `fn` propagates out of the run, and hooks that saw that instruction see it again on the
     * next run.
     * @param {function(number): *} fn - its return value is ignored
     * @returns {function(): void} removes the watcher
     */
    onExecute(fn) {
        const hook = this._machine.processor.debugInstruction.add((pc) => {
            fn(pc);
        });
        let removed = false;
        return () => {
            if (!removed) hook.remove();
            removed = true;
        };
    }

    /**
     * Remove a breakpoint by id.
     */
    removeBreakpoint(id) {
        const bp = this._breakpoints.get(id);
        if (!bp) throw new Error(`No breakpoint with id ${id}`);
        bp.hook.remove();
        this._breakpoints.delete(id);
    }

    /**
     * Remove all breakpoints.
     */
    clearBreakpoints() {
        for (const bp of this._breakpoints.values()) {
            bp.hook.remove();
        }
        this._breakpoints.clear();
    }

    /**
     * Return the first breakpoint that was hit since the last reset, or null.
     */
    hitBreakpoint() {
        for (const bp of this._breakpoints.values()) {
            if (bp.hit) {
                const result = { id: bp.id, type: bp.type, address: bp.address };
                if (bp.bank !== undefined) result.bank = bp.bank;
                if (bp.value !== undefined) result.value = bp.value;
                return result;
            }
        }
        return null;
    }

    /**
     * Reset all hit flags (call before starting a new run).
     */
    resetBreakpointHits() {
        for (const bp of this._breakpoints.values()) {
            bp.hit = false;
        }
    }

    /**
     * Load a disc image (absolute or relative path to an .ssd or .dsd file).
     *
     * We read the file ourselves rather than delegating to TestMachine.loadDisc,
     * which goes through utils.loadData and mangles absolute paths by prepending "./".
     */
    loadDisc(imagePath) {
        const data = new Uint8Array(readFileSync(imagePath));
        this._machine.processor.fdc.loadDisc(0, fdc.discFor(imagePath, data));
    }

    /**
     * Put a tape (a .uef, or a tapefile) in the cassette recorder, from a file,
     * or from `data` already read with `name` for the messages, and press PLAY.
     * The Atom's recorder has no relay, so its tape runs at once; another
     * model's runs when the MOS starts the motor (`*TAPE` then `CHAIN""`, say).
     */
    async loadTape(name, data = new Uint8Array(readFileSync(name))) {
        const { tapeInterface, model } = this._machine.processor;
        tapeInterface.setTape(await loadTapeFromData(name, data, model));
        tapeInterface.pressPlay();
    }

    /**
     * Put a disc in a drive by any reference the web page's URL accepts: a bare
     * name from the built-in discs (in a jsbeeb checkout; the npm package leaves them out),
     * `sth:`, `hfe:` or `bitshifters:` for the archives, `github:` for a file in a GitHub repo, or a URL.
     * Returns the name of the image loaded and any others the archive held.
     */
    async loadDiscImage(ref, drive = 0) {
        const { name, data, ignored } = await this.mediaResolver().resolve("disc", ref);
        this._machine.processor.fdc.loadDisc(drive, fdc.discFor(name, data));
        return { name, ignored };
    }

    mediaResolver() {
        if (!this._mediaResolver) {
            this._mediaResolver = new MediaResolver();
            this._mediaResolver.addSource("sth", (file) => new StairwayToHell().fetch(file));
            this._mediaResolver.addSource("tapeSth", (file) => new StairwayToHell({ tapes: true }).fetch(file));
            this._mediaResolver.addSource("hfe", (path) => new BbcDiscArchive().fetch(path));
            this._mediaResolver.addSource("bitshifters", (path) => new BitshiftersArchive().fetch(path));
        }
        return this._mediaResolver;
    }

    /**
     * Return all VDU text elements captured so far.
     *
     * @param {Object} [opts]
     * @param {boolean} [opts.clear=true] - If true (default), clear the buffer
     *   after returning it.  Pass false to peek without consuming; the same
     *   elements will be returned again on the next call.
     *
     * Each element: { x, y, text, foreground, background, mode }
     * Also includes a flat `screenText` reconstruction.
     */
    drainOutput({ clear = true } = {}) {
        this._capture.flush();
        const elements = clear ? this._pendingOutput.splice(0) : [...this._pendingOutput];
        return {
            elements,
            screenText: reconstructScreenText(elements),
        };
    }

    /**
     * What the memory map has paged in: `romsel` as last written, `bank`,
     * the sideways bank it pages at &8000 to &BFFF, and on a Master
     * `acccon`, whose bit 2 puts shadow RAM at &3000 to &7FFF.
     * @returns {{romsel: number, bank: number, acccon?: number}}
     */
    pagingState() {
        const cpu = this._machine.processor;
        const state = { romsel: cpu.romsel, bank: cpu.pagedBank };
        if (cpu.model.isMaster) state.acccon = cpu.acccon;
        return state;
    }

    /**
     * Runs `fn` with `bank` paged at &8000, or shadow RAM paged (or not)
     * at &3000, putting the map back afterwards. Either left undefined
     * leaves the map as the machine has it.
     */
    _withPaging({ bank, shadow }, fn) {
        const cpu = this._machine.processor;
        const { romsel, acccon } = cpu;
        requireBank(bank, cpu.model);
        if (shadow !== undefined && !cpu.model.isMaster) throw new Error("Only a Master has shadow RAM");
        try {
            if (bank !== undefined) cpu.romSelect(bank);
            if (shadow !== undefined) cpu.writeAcccon(shadow ? acccon | AccconShadowBit : acccon & ~AccconShadowBit);
            return fn();
        } finally {
            if (bank !== undefined) cpu.romSelect(romsel);
            if (shadow !== undefined) cpu.writeAcccon(acccon);
        }
    }

    /**
     * Read `length` bytes from emulator memory starting at `address`, from
     * whatever is paged in unless `bank` or `shadow` says otherwise.
     * @param {number} address
     * @param {number} [length=16]
     * @param {Object} [opts]
     * @param {number} [opts.bank] sideways bank to read at &8000 to &BFFF
     * @param {boolean} [opts.shadow] on a Master, read shadow RAM (true) or main RAM (false) at &3000 to &7FFF
     */
    readMemory(address, length = 16, { bank, shadow } = {}) {
        return this._withPaging({ bank, shadow }, () => {
            const bytes = [];
            for (let i = 0; i < length; i++) {
                bytes.push(this._machine.readbyte(address + i));
            }
            return bytes;
        });
    }

    /**
     * Write an array of byte values into emulator memory at `address`;
     * `bank` and `shadow` pick where, as for readMemory.
     */
    writeMemory(address, bytes, { bank, shadow } = {}) {
        this._withPaging({ bank, shadow }, () => {
            for (let i = 0; i < bytes.length; i++) {
                this._machine.writebyte(address + i, bytes[i]);
            }
        });
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
     * including borders, matching what the browser renders).
     *
     * The active display area is roughly:
     *   x: leftBorder .. 1024-rightBorder
     *   y: topBorder  .. 625-bottomBorder
     */
    async screenshot() {
        // Read from _completeFb8, the last fully-painted frame snapshotted in paint_ext.
        // The video's fb32 is the live render buffer (cleared and partially refilled each frame).
        const { default: sharp } = await import("sharp");
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

        const { default: sharp } = await import("sharp");
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
        this._video.fb32.fill(0);
        this._pendingOutput = [];
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Throws unless `bank`, if given, is a sideways bank. */
function requireBank(bank, { romSockets }) {
    const lowest = NumRomBanks - romSockets;
    const highest = NumRomBanks - 1;
    if (bank !== undefined && (!Number.isInteger(bank) || bank < lowest || bank > highest))
        throw new Error(`Bank ${bank} is not ${lowest} to ${highest}`);
}

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
