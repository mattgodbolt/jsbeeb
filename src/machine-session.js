/**
 * MachineSession - wraps jsbeeb's TestMachine with:
 *   - real Video framebuffer (so screenshots work)
 *   - accumulated text output between calls
 *   - clean lifecycle (boot, interact, screenshot, destroy)
 */

import { readFileSync } from "fs";
import { TestMachine } from "./test-machine.js";
import { VduTextCapture } from "./vdu-capture.js";
import { InstrumentedSoundChip, FakeSoundChip } from "./soundchip.js";
import * as fdc from "./fdc.js";
import { loadTapeFromData } from "./tapes.js";
import { MediaResolver } from "./media-resolver.js";
import { StairwayToHell } from "./sth.js";
import { BitshiftersArchive } from "./bitshifters.js";
import { BbcDiscArchive } from "./bbcdiscs.js";
import { Video } from "./video.js";
import { findModel } from "./models.js";
import { requireBank } from "./paging.js";
import { hexbyte, hexword } from "./hex.js";
import { ReplayHistory, finished, snapshotCycle } from "./replay.js";
import { RewindBuffer } from "./rewind.js";
import { cycleCount } from "./lockstep.js";

// BBC framebuffer is 1024×625 pixels
const FB_WIDTH = 1024;
const FB_HEIGHT = 625;

export const MaxLoggedHits = 10000;
const BreakpointUpdateFields = ["bank", "end", "line", "condition", "hitCount", "action", "enabled"];

// Bit X of ACCCON: shadow RAM in place of main at &3000 to &7FFF.
const AccconShadowBit = 4;

// Where the MOS keeps its read and write offsets into the keyboard buffer (buffer 0), which is empty when they
// are equal.
const KeyboardBufferOffsets = { read: 0x2d8, write: 0x2e1 };
const MasterKeyboardBufferOffsets = { read: 0x2d7, write: 0x2e0 };

// At most one recent snapshot a frame, as the page takes them.
const RecentSnapshotsPerSecond = 50;
const NoHistory = "The session keeps no history to step back through: keepHistory turns it on.";
const StillTyping = "Text from type() is still being typed, which a replay cannot put back.";

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
     *   takes them: a name or path under roms/, a `file:` or `http(s):` URL, or a `github:` reference; an empty
     *   name is skipped, as the page skips it
     * @param {{bank: number, rom: string}[]} [opts.bankRoms] - sideways ROMs for the banks they name, as the page's
     *   `rom.N=`, skipping one with an empty name; initialise() throws for a bank the model has no socket for, one
     *   the model or its fittings fill, or one named twice
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
            extraRoms: opts.extraRoms?.filter((rom) => rom),
            bankRoms: opts.bankRoms?.filter(({ rom }) => rom),
        });

        // Accumulated VDU text output, drained by callers
        this._pendingOutput = [];
        this._capture = new VduTextCapture((element) => this._pendingOutput.push(element), { isAtom: this._isAtom });

        /** The hit that stopped the machine for each of this session's breakpoints, or null. */
        this._breakpointHits = new Map();
        this._breakpointLog = [];
        this._breakpointLogDropped = 0;

        this._history = null;
        this._historySizes = { recent: 0, seconds: 0 };
        this._historyRings = [];
    }

    /** Load ROMs and hardware; call once before anything else */
    async initialise() {
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
        if (!hard) this._machine.processor.inputLog?.record({ kind: "reset" });
        this._machine.processor.reset(hard);
        if (hard) this._restartHistory();
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
        this._restartHistory();
        this._pendingOutput = state.pendingOutput.map((element) => ({ ...element }));
        this._capture.restore(state.capture);
    }

    /**
     * Keep the machine's history as it runs, for stepBack and the rest to replay, as the page keeps it for its
     * debugger: `recent` snapshots at most a frame apart, and `seconds` more a second apart (PageHistory in
     * replay.js is what the page keeps). Zero for both keeps none. Forgets any history kept before.
     * @param {{recent: number, seconds: number}} sizes
     */
    keepHistory({ recent, seconds }) {
        if (![recent, seconds].every((size) => Number.isInteger(size) && size >= 0)) {
            throw new Error(`keepHistory: give whole numbers of snapshots, not ${recent} and ${seconds}`);
        }
        const cpu = this._machine.processor;
        this._history?.log.detach();
        this._history = null;
        this._historySizes = { recent, seconds };
        this._historyRings = [];
        this._machine.betweenExecutes = null;
        if (recent === 0 && seconds === 0) return;
        this._history = new ReplayHistory(cpu);
        this._history.addEventListener("landed", ({ detail }) => {
            for (const { ring } of this._historyRings) {
                while (ring.length > 0 && detail.forgotten.has(ring.peek())) ring.pop();
            }
        });
        const { cyclesPerSecond } = cpu.model;
        this._historyRings = [
            { ring: new RewindBuffer(recent), apart: cyclesPerSecond / RecentSnapshotsPerSecond },
            { ring: new RewindBuffer(seconds), apart: cyclesPerSecond },
        ].filter(({ ring }) => ring.maxSnapshots > 0);
        this._machine.betweenExecutes = () => this._takeHistorySnapshots();
        this._takeHistorySnapshots();
    }

    /**
     * How much history the session keeps (see keepHistory), and how much it has: how many snapshots, and the cycle
     * of the oldest, from which a replay can start, or null if there are none.
     * @returns {{recent: number, seconds: number, snapshots: number, oldestCycle: number|null}}
     */
    historyState() {
        const snapshots = this._history?.snapshots() ?? [];
        const cpu = this._machine.processor;
        return {
            ...this._historySizes,
            snapshots: snapshots.length,
            oldestCycle: snapshots.length ? snapshotCycle(cpu, snapshots[0]) : null,
        };
    }

    _takeHistorySnapshots() {
        const cpu = this._machine.processor;
        const now = cycleCount(cpu);
        let taken = false;
        for (const { ring, apart } of this._historyRings) {
            const newest = ring.peek();
            if (newest && now - snapshotCycle(cpu, newest) < apart) continue;
            const replacing = ring.nextToReplace();
            const snapshot = cpu.snapshotState({ into: replacing });
            ring.push(snapshot);
            this._history.taken(snapshot, replacing);
            taken = true;
        }
        if (taken) this._history.trim();
    }

    // The machine's state is being replaced, so nothing from before it is a past it had.
    _restartHistory() {
        if (!this._history) return;
        for (const { ring } of this._historyRings) ring.clear();
        this._history.restart();
    }

    /**
     * Run `replay` on the history, returning why it could not, or what it returns. A step back leaves the
     * breakpoints' hit flags clear, as what stopped the machine is now in its future, and leaves the captured text
     * as it was.
     */
    _replaying(replay) {
        if (!this._history) return NoHistory;
        if (this.typingPending) return StillTyping;
        const refusal = replay(this._history);
        if (refusal === null) this.resetBreakpointHits();
        return refusal;
    }

    /**
     * Step the machine back one instruction, or with `over` back over the call the instruction before returned
     * from, replaying the history keepHistory keeps. Returns why it could not, leaving the machine as it was, or null.
     * @param {boolean} over
     * @returns {string|null}
     */
    stepBack(over) {
        return this._replaying((history) => history.stepBack(over));
    }

    /** Step the machine back to the call or interrupt that entered the routine it is in, as stepBack does. */
    stepBackOut() {
        return this._replaying((history) => finished(history.stepBackOut()));
    }

    /**
     * Step the machine back to where it would have stopped at the newest breakpoint or watch hit before now, as
     * stepBack does, counting every hit whatever a breakpoint's hit count.
     */
    reverseContinue() {
        return this._replaying((history) => finished(history.reverseContinue()));
    }

    /**
     * The last write to `address`, as the machine pages it now, found by replaying the history and leaving the
     * machine as it was: `{ refusal }` if it cannot search, or else `{ write, searched, stoppedBy }` as
     * ReplayHistory's lastWrite gives them, `write` being `{ pc, cycle, value }` or null if nothing wrote it in the
     * `searched` cycles back from now.
     * @param {number} address
     */
    whoWrote(address) {
        if (!this._history) return { refusal: NoHistory };
        if (this.typingPending) return { refusal: StillTyping };
        return finished(this._history.lastWrite(address));
    }

    /** Tokenise BBC BASIC source and write it into PAGE */
    async loadBasic(source) {
        await this._machine.loadBasic(source);
        this._machine.processor.inputLog?.refuse("a BASIC program going into memory");
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
     * Add a persistent breakpoint, one of the processor's `breakpoints`, which stays until removed and, unless it
     * logs, stops the run it fires in. Returns the breakpoint id.
     * @param {"execute"|"read"|"write"|"access"|"brk"|"undocumented"|"irq"|"nmi"|"vsync"|"line"} type - access is a
     *     read or a write; the rest have no address, as src/breakpoints.js describes
     * @param {number | undefined} address
     * @param {Object} [opts]
     * @param {number} [opts.bank] only break while this sideways bank is paged in where it is hit (on a Master,
     *     not while ANDY is paged over &8000 to &8FFF)
     * @param {number} [opts.end] the last address it covers, for a range from `address`
     * @param {number} [opts.line] the TV line a line breakpoint stops at
     * @param {string} [opts.condition] as src/conditions.js describes, e.g. "A = &0D AND ?&70 <> 0"
     * @param {number} [opts.hitCount] act on this hit and every one after
     * @param {"stop"|"log"} [opts.action] log records each hit for drainBreakpointLog() and runs on
     * @param {boolean} [opts.enabled]
     * @returns {number} breakpoint id
     */
    addBreakpoint(type, address, { bank, end, line, condition, hitCount, action, enabled } = {}) {
        const id = this._breakpoints.add({
            kind: type,
            start: address,
            end,
            bank,
            line,
            condition,
            hitCount,
            action,
            enabled,
            owner: "session",
            onHit: (hit) => {
                if (hit.action !== "log") this._breakpointHits.set(id, hit);
                else if (this._breakpointLog.length < MaxLoggedHits) this._breakpointLog.push(hit);
                else this._breakpointLogDropped++;
            },
        });
        this._breakpointHits.set(id, null);
        return id;
    }

    /**
     * Change the fields `changes` gives of breakpoint `id`, as addBreakpoint's options name them.
     * @param {number} id
     * @param {{bank?: number, end?: number, line?: number, condition?: string, hitCount?: number,
     *     action?: "stop"|"log", enabled?: boolean}} changes
     */
    updateBreakpoint(id, changes) {
        this._requireOwnBreakpoint(id);
        const fields = BreakpointUpdateFields.filter((field) => field in changes);
        this._breakpoints.update(id, Object.fromEntries(fields.map((field) => [field, changes[field]])));
    }

    /** This session's breakpoints, with how often each has been hit. */
    listBreakpoints() {
        return [...this._breakpointHits.keys()].map((id) => {
            const { kind, start, end, bank, line, condition, hitCount, action, enabled, hits } =
                this._breakpoints.get(id);
            return { id, type: kind, address: start, end, bank, line, condition, hitCount, action, enabled, hits };
        });
    }

    /**
     * The hits of `log` breakpoints since the last call, oldest first, and how many more there were past the
     * first MaxLoggedHits, which are not kept.
     * @returns {{hits: object[], dropped: number}}
     */
    drainBreakpointLog() {
        const drained = { hits: this._breakpointLog, dropped: this._breakpointLogDropped };
        this._breakpointLog = [];
        this._breakpointLogDropped = 0;
        return drained;
    }

    get _breakpoints() {
        return this._machine.processor.breakpoints;
    }

    _requireOwnBreakpoint(id) {
        if (!this._breakpointHits.has(id)) throw new Error(`No breakpoint with id ${id}`);
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
        this._requireOwnBreakpoint(id);
        this._breakpoints.remove(id);
        this._breakpointHits.delete(id);
    }

    /**
     * Remove all breakpoints.
     */
    clearBreakpoints() {
        for (const id of this._breakpointHits.keys()) this._breakpoints.remove(id);
        this._breakpointHits.clear();
    }

    /**
     * Return the first breakpoint that stopped the machine since the last reset, or null: its id, type and the
     * address hit (an interrupt's handler, or the instruction for a breakpoint with no address), its bank if it has
     * one, and the byte read or written.
     */
    hitBreakpoint() {
        for (const [id, hit] of this._breakpointHits) {
            if (!hit) continue;
            const { kind, bank } = this._breakpoints.get(id);
            const result = { id, type: kind, address: hit.address };
            if (bank !== undefined) result.bank = bank;
            if (hit.value !== undefined) result.value = hit.value;
            return result;
        }
        return null;
    }

    /**
     * Reset all hit flags (call before starting a new run). Hit counts carry on, so a breakpoint with a hitCount
     * stays armed once reached.
     */
    resetBreakpointHits() {
        for (const id of this._breakpointHits.keys()) this._breakpointHits.set(id, null);
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
        this._machine.processor.inputLog?.refuse("a disc change in drive 0");
    }

    /**
     * Put a tape (a .uef, or a tapefile) in the cassette recorder, from a file,
     * or from `data` already read with `name` for the messages, and press PLAY.
     * The Atom's recorder has no relay, so its tape runs at once; another
     * model's runs when the MOS starts the motor (`*TAPE` then `CHAIN""`, say).
     */
    async loadTape(name, data = new Uint8Array(readFileSync(name))) {
        const { tapeInterface, model, inputLog } = this._machine.processor;
        tapeInterface.setTape(await loadTapeFromData(name, data, model));
        tapeInterface.pressPlay();
        inputLog?.refuse("a tape change");
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
        this._machine.processor.inputLog?.refuse(`a disc change in drive ${drive}`);
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
        const { inputLog } = this._machine.processor;
        const repaged = bank !== undefined || shadow !== undefined;
        if (repaged) inputLog?.refuse("a write to memory paged in for that write alone");
        this._withPaging({ bank, shadow }, () => {
            for (let i = 0; i < bytes.length; i++) {
                if (!repaged) inputLog?.record({ kind: "write", address: address + i, value: bytes[i] });
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
            pcHex: `0x${hexword(cpu.pc).toUpperCase()}`,
            aHex: `0x${hexbyte(cpu.a).toUpperCase()}`,
            xHex: `0x${hexbyte(cpu.x).toUpperCase()}`,
            yHex: `0x${hexbyte(cpu.y).toUpperCase()}`,
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
        return (await this._completeFrame()).png().toBuffer();
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

        return (await this._completeFrame())
            .extract({ left, top, width: w, height: h })
            .resize(w * scale, h * scale, { kernel: "nearest" }) // nearest-neighbour keeps pixels crisp
            .png()
            .toBuffer();
    }

    /** A sharp image of the last complete frame. */
    async _completeFrame() {
        const { default: sharp } = await import("sharp");
        return sharp(Buffer.from(this._completeFb8.buffer), {
            raw: { width: FB_WIDTH, height: FB_HEIGHT, channels: 4 },
        });
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
