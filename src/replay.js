// Stepping the machine backwards, or searching back through what it did: it is put back to a snapshot from before
// where it is to go, and run forward to there exactly. Snapshots leave out what the host gives the machine (keys,
// FIRE buttons, BREAK, a debugger's edits) and what the machine reads from the host as it runs (the analogue
// channels, the clock, the touchscreen), so an InputLog records both as they happen, and a replay puts each back
// where it went in or was read.

import { applyInput, cycleCount, stateHash } from "./lockstep.js";
import { tickCycles } from "./emulation-tick.js";
import { NoReplayHooks } from "./6502.js";

// How far back step back over looks for the call it is to land on, past which the wait is not worth it.
const LongestCallSearchSeconds = 2;
const InterruptPushes = 3;

// As the CPU's memStat marks a page.
const RamStat = 1;
const RomStat = 2;

const KeepsHistory =
    "the machine keeps its history once it has run a frame since it started, was reset or had its state replaced";
const NothingToStepBackTo = `There is nothing to step back to: ${KeepsHistory}.`;
const NothingToSearch = `There is no history to search back through: ${KeepsHistory}.`;
const NotRepeated = "Step back could not repeat the machine's run exactly, so the machine is left where it was.";
const NoCallFound = `Step back over found no call this returned from in the last ${LongestCallSearchSeconds} seconds.`;
const TooFarBack = "That is further back than the machine keeps its history.";
const NotBehind = "That is not before where the machine is now.";
const IsRom = "That is ROM, which a write leaves as it is.";
const NotRepeatedHere = "The search could not repeat the machine's run since its newest snapshot exactly.";
const CannotSearchPast = "The search cannot go back past";
const MovedOn = "The machine moved on before the search back finished.";
const Unrepeated = "a stretch of the run it could not repeat exactly";
const MidInstruction = "an input that came part way through an instruction, as a paste's or an autotype's keys do";

// S counts down and wraps, so "not deeper" is a difference of under half the page, either way round $00.
export function notDeeper(s, startS) {
    return ((s - startS) & 0xff) < 0x80;
}

const MicrosecondsPerSecond = 1e6;
const MillisecondsPerSecond = 1e3;

/** `seconds` in the unit that suits it, to a tenth. */
export function durationText(seconds) {
    if (seconds * MillisecondsPerSecond < 1) return `${(seconds * MicrosecondsPerSecond).toFixed(1)} \u00b5s`;
    if (seconds < 1) return `${(seconds * MillisecondsPerSecond).toFixed(1)} ms`;
    return `${seconds.toFixed(1)} s`;
}

export const snapshotCycle = (cpu, snapshot) =>
    snapshot.cycleSeconds * cpu.model.cyclesPerSecond + snapshot.currentCycles;

/** Runs `generator` to its end, returning what it returns. */
export function finished(generator) {
    for (;;) {
        const { done, value } = generator.next();
        if (done) return value;
    }
}

/**
 * Runs `run` with `video` painting nothing to the screen, as the benchmark page's video-only pass does, so that the
 * screen keeps showing the machine as it stands while its past is replayed.
 */
function withoutPainting(video, run) {
    const paint = video.paint_ext;
    video.paint_ext = () => {};
    try {
        return run();
    } finally {
        video.paint_ext = paint;
    }
}

// Between executes the CPU has reached its cycle target or been stopped short of it; inside one, as a scheduled
// task or a debug hook runs, it has done neither.
const insideExecute = (cpu) => !cpu.halted && cpu.currentCycles < cpu.targetCycles;

function hostInputs(cpu) {
    const { gamepad, mouse } = cpu.sysvia.fireButtons();
    return { keyboard: cpu.keyboardInterface.keyboardState(), gamepad, mouse, resetting: !cpu.resetLine };
}

/** What the host holds once `input` has gone in, from `host`, what it held before. */
function withInput(host, input) {
    switch (input.kind) {
        case "keyboard":
            return { ...host, keyboard: input.state };
        case "gamepadFire":
            return { ...host, gamepad: [input.button1, input.button2] };
        case "joystickButton":
            return {
                ...host,
                mouse: host.mouse.map((pressed, button) => (button === input.button ? input.pressed : pressed)),
            };
        case "break":
            return { ...host, resetting: input.down };
        default:
            return host;
    }
}

/** The inputs that take the host from holding `from` to holding `to`. */
function hostChanges(from, to) {
    const changes = [];
    if (JSON.stringify(from.keyboard) !== JSON.stringify(to.keyboard)) {
        changes.push({ kind: "keyboard", state: to.keyboard });
    }
    if (from.gamepad.some((pressed, button) => pressed !== to.gamepad[button])) {
        changes.push({ kind: "gamepadFire", button1: to.gamepad[0], button2: to.gamepad[1] });
    }
    to.mouse.forEach((pressed, button) => {
        if (pressed !== from.mouse[button]) changes.push({ kind: "joystickButton", button, pressed });
    });
    if (from.resetting !== to.resetting) changes.push({ kind: "break", down: to.resetting });
    return changes;
}

// Before the machine's own restore, as restoreSessionSnapshot puts the keys back, so that its VIA scans these.
function restoreHostInputs(cpu, { keyboard, gamepad, mouse, resetting }) {
    cpu.keyboardInterface.restoreKeyboard(keyboard);
    cpu.sysvia.setGamepadFire(...gamepad);
    mouse.forEach((pressed, button) => cpu.sysvia.setJoystickButton(button, pressed));
    cpu.setReset(resetting);
}

// As far as `cycle`, an instruction boundary, in the page's ticks as everything else that runs execute does; false
// if something stopped the machine short of it.
function runTo(cpu, cycle) {
    const longest = tickCycles(cpu.model.cyclesPerSecond);
    while (cycleCount(cpu) < cycle) {
        const end = Math.min(cycle, cycleCount(cpu) + longest);
        cpu.targetCycles = end - cpu.cycleSeconds * cpu.model.cyclesPerSecond;
        if (!cpu.execute(0)) return false;
    }
    return true;
}

/** The samples a replay hands the machine, in place of the host, each as it was when the original run read it. */
class SampleReplay {
    constructor(samples, from, values) {
        this.samples = samples;
        this.next = samples.findIndex(({ at }) => at > from);
        if (this.next < 0) this.next = samples.length;
        this.values = values;
    }

    // A read the original run never made, as in a replay gone its own way, gets the host's value, and the check
    // at the end of the replay finds it out.
    read(key, at, live) {
        while (this.next < this.samples.length && this.samples[this.next].at <= at) {
            const { key: read, value } = this.samples[this.next++];
            this.values.set(read, value);
        }
        return this.values.has(key) ? this.values.get(key) : live;
    }
}

/**
 * What the host gave the machine and what the machine read from the host, from where a replay can start. Inputs
 * are recorded with the cycle they went in at, between executes, as `{ at, input }` in the shape `applyInput`
 * takes; samples with the cycle they were read at, only as they change; and refusals, `{ at, refusal }`, where
 * something went in that no replay can put back, which no replay crosses. Every device the host reaches holds it
 * as `inputLog`, and while it replays it gives them the samples instead of the host and records nothing.
 */
export class InputLog {
    constructor(cpu) {
        this.cpu = cpu;
        this.latestSamples = new Map();
        this.sampleReplay = null;
        this.recording = true;
        this.applyingInput = false;
        const { keyboardInterface, sysvia, adconverter, touchScreen, acia, fdc } = cpu;
        for (const device of [
            cpu,
            keyboardInterface,
            sysvia,
            adconverter,
            touchScreen,
            sysvia.cmos,
            acia,
            ...fdc.drives,
        ])
            device.inputLog = this;
        this.restart();
    }

    /** Forgets everything recorded, the machine's state having been replaced; replays start from here on. */
    restart() {
        this.inputs = [];
        this.samples = [];
        this.base = hostInputs(this.cpu);
        this.baseSamples = new Map(this.latestSamples);
    }

    get isEmpty() {
        return this.inputs.length === 0 && this.samples.length === 0;
    }

    record(input) {
        if (!this.recording) return;
        if (insideExecute(this.cpu)) this.refuse(MidInstruction);
        else this.inputs.push({ at: cycleCount(this.cpu), input });
    }

    /** Notes that something went in here that no replay can put back, `reason` naming it for the refusal. */
    refuse(reason) {
        if (this.recording) this.inputs.push({ at: cycleCount(this.cpu), refusal: reason });
    }

    /** What the machine reads for `key` from the host, which said `value`. */
    sample(key, value) {
        if (this.sampleReplay) return this.sampleReplay.read(key, cycleCount(this.cpu), value);
        if (this.recording && this.latestSamples.get(key) !== value) {
            this.latestSamples.set(key, value);
            this.samples.push({ at: cycleCount(this.cpu), key, value });
        }
        return value;
    }

    /** What the host held at `cycle`, before any input that went in there. */
    hostAt(cycle) {
        let host = this.base;
        for (const { at, input } of this.inputs) {
            if (at >= cycle) break;
            if (input) host = withInput(host, input);
        }
        return host;
    }

    /** The latest of each sample read up to `cycle`. */
    samplesAt(cycle) {
        const values = new Map(this.baseSamples);
        for (const { at, key, value } of this.samples) {
            if (at > cycle) break;
            values.set(key, value);
        }
        return values;
    }

    /** The first refusal from `from` to `to`, both included, or null. */
    refusalBetween(from, to) {
        return this.inputs.find(({ at, refusal }) => refusal && at >= from && at <= to)?.refusal ?? null;
    }

    /** Folds into where a replay starts everything before `cycle`, from where no replay starts any more. */
    trimBefore(cycle) {
        const firstInput = this.inputs.findIndex(({ at }) => at >= cycle);
        if (firstInput !== 0) {
            this.base = this.hostAt(cycle);
            this.inputs = firstInput < 0 ? [] : this.inputs.slice(firstInput);
        }
        const firstSample = this.samples.findIndex(({ at }) => at > cycle);
        if (firstSample !== 0) {
            this.baseSamples = this.samplesAt(cycle);
            this.samples = firstSample < 0 ? [] : this.samples.slice(firstSample);
        }
    }

    /** Forgets what went in after `cycle`, the machine having gone back there, and carries on from what it read. */
    forgetAfter(cycle) {
        this.inputs = this.inputs.filter(({ at }) => at <= cycle);
        this.samples = this.samples.filter(({ at }) => at <= cycle);
        this.latestSamples = this.samplesAt(cycle);
    }

    /** Runs `run` recording nothing, as when the machine is put back as it was. */
    withoutRecording(run) {
        this.recording = false;
        try {
            return run();
        } finally {
            this.recording = true;
        }
    }

    /**
     * Puts the machine back to `snapshot` and runs it to `to` as a replay (as `asReplay` runs one, watched by
     * `hooks`), putting each input back at its cycle, those at `to` too if `inputsAtTo`, with
     * `applyingInput` set as each goes in. Returns the hash of the machine as the snapshot put it, or null if the
     * replay did not reach an input's cycle or `to` exactly.
     */
    replay(snapshot, to, inputsAtTo, hooks) {
        const { cpu } = this;
        const from = snapshotCycle(cpu, snapshot);
        this.recording = false;
        this.sampleReplay = new SampleReplay(this.samples, from, this.samplesAt(from));
        try {
            restoreHostInputs(cpu, this.hostAt(from));
            cpu.restoreState(snapshot);
            cpu.debugInstruction.forgetStop();
            const startHash = stateHash(cpu);
            const reached = cpu.asReplay(hooks, () => {
                for (const { at, input } of this.inputs) {
                    if (at < from || !input) continue;
                    if (at > to || (at === to && !inputsAtTo)) break;
                    if (!runTo(cpu, at) || cycleCount(cpu) !== at) return false;
                    this.applyingInput = true;
                    try {
                        applyInput(cpu, input);
                    } finally {
                        this.applyingInput = false;
                    }
                }
                return runTo(cpu, to) && cycleCount(cpu) === to;
            });
            return reached ? startHash : null;
        } finally {
            this.sampleReplay = null;
            this.recording = true;
        }
    }
}

/**
 * Where a step back lands, worked out from the instructions replays pass the start of, a window at a time from
 * the newest. Back one, it is the last instruction of the first window. Back over, it is the same unless that
 * instruction returned to here (a return with the stack shallower after it); then it is the last instruction
 * before it at a stack no deeper than here, the call that return came back from, in whichever window has one, as
 * far back as is worth the wait.
 */
class Landing {
    constructor(cpu, over) {
        this.cpu = cpu;
        this.over = over;
        this.s = cpu.s;
        this.seekingCall = false;
        this.searchFrom = cycleCount(cpu) - LongestCallSearchSeconds * cpu.model.cyclesPerSecond;
        this.hooks = { ...NoReplayHooks, instruction: (_pc, opcode) => this.passing(opcode) };
    }

    searches(from) {
        return !this.seekingCall || from >= this.searchFrom;
    }

    startWindow() {
        this.last = null;
        this.lastS = 0;
        this.lastOpcode = 0;
        this.notDeeperBeforeLast = null;
    }

    passing(opcode) {
        if (this.last !== null && notDeeper(this.lastS, this.s)) this.notDeeperBeforeLast = this.last;
        this.last = cycleCount(this.cpu);
        this.lastS = this.cpu.s;
        this.lastOpcode = opcode;
    }

    /** The cycle to land on from the window just replayed, or null to look in the one before it. */
    inWindow() {
        if (this.seekingCall)
            return this.last !== null && notDeeper(this.lastS, this.s) ? this.last : this.notDeeperBeforeLast;
        const returnedHere =
            this.cpu.disassembler.describeOpcode(this.lastOpcode).flow === "return" &&
            this.s !== this.lastS &&
            notDeeper(this.s, this.lastS);
        if (!this.over || !returnedHere) return this.last;
        this.seekingCall = true;
        return this.notDeeperBeforeLast;
    }
}

/** A step back to `cycle`, an instruction boundary, landed on from the window that holds it. */
class Arrival {
    constructor(cycle) {
        this.cycle = cycle;
        this.from = 0;
        this.hooks = NoReplayHooks;
    }

    searches() {
        return true;
    }

    startWindow(from) {
        this.from = from;
    }

    inWindow() {
        return this.from <= this.cycle ? this.cycle : null;
    }
}

/**
 * The last write in a window to the byte a write to `address` reaches as the machine is paged now: the same byte
 * of RAM, however the CPU paged it there at the time, or else a device register at the same address.
 */
class LastWrite {
    constructor(cpu, log, address) {
        const page = cpu.memStatOffset + (address >>> 8);
        const [stat, look] = [cpu.memStat[page], cpu.memLook[page]];
        let pc = 0;
        let started = 0;
        this.found = null;
        const instruction = (at) => {
            pc = at;
            started = cycleCount(cpu);
        };
        const write = (written, value) => {
            if (written !== address) return;
            const writtenPage = cpu.memStatOffset + (address >>> 8);
            const writtenStat = cpu.memStat[writtenPage];
            if (writtenStat !== stat) return;
            if (stat === RamStat && cpu.memLook[writtenPage] !== look) return;
            const byte = value & 0xff;
            this.found = log.applyingInput
                ? { pc: null, cycle: cycleCount(cpu), value: byte }
                : { pc, cycle: started, value: byte };
        };
        this.hooks = { ...NoReplayHooks, instruction, write };
    }

    searches() {
        return true;
    }

    startWindow() {
        this.found = null;
    }

    inWindow() {
        return this.found;
    }
}

/**
 * Where a step back out lands: the latest instruction that entered a routine, a JSR or BRK or one an interrupt was
 * taken after, whose stack is shallower than here and than at every instruction after it. Each window keeps only
 * the instructions shallower than every one after them in it, the only ones it could be.
 */
class OutLanding {
    constructor(cpu) {
        this.cpu = cpu;
        this.s = cpu.s;
        this.highestAfter = 0;
        this.hooks = {
            ...NoReplayHooks,
            instruction: (_pc, opcode) => this.passing(opcode),
            // Entered from the stack the instruction before left, which the interrupt pushed three bytes onto.
            interrupt: () =>
                this._keep(this.shallower.at(-1).cycle, this._height((this.cpu.s + InterruptPushes) & 0xff), true),
        };
    }

    searches() {
        return true;
    }

    // How many bytes shallower than here the stack is at `s`, negative for deeper.
    _height(s) {
        const above = (s - this.s) & 0xff;
        return above < 0x80 ? above : above - 0x100;
    }

    startWindow() {
        this.shallower = [];
    }

    passing(opcode) {
        const { flow } = this.cpu.disassembler.describeOpcode(opcode);
        this._keep(cycleCount(this.cpu), this._height(this.cpu.s), flow === "call" || flow === "interrupt");
    }

    _keep(cycle, height, enters) {
        while (this.shallower.length && this.shallower.at(-1).height <= height) this.shallower.pop();
        this.shallower.push({ cycle, height, enters });
    }

    inWindow() {
        const entry = this.shallower.findLast(({ enters, height }) => enters && height > this.highestAfter);
        if (entry) return entry.cycle;
        this.highestAfter = Math.max(this.highestAfter, this.shallower[0].height);
        return null;
    }
}

/**
 * What the debugger can step back through: the snapshots kept of the machine since its state was last replaced,
 * and the input log back to the oldest of them. Dispatches "landed", with the snapshots it forgot as
 * `detail.forgotten`, once a step back has forgotten everything after where it landed, for whoever else keeps them.
 */
export class ReplayHistory extends EventTarget {
    constructor(cpu) {
        super();
        this.cpu = cpu;
        this.log = new InputLog(cpu);
        this.kept = new Set();
    }

    /** Takes `snapshot` as one a replay can start from, in place of `replacing`, if any, whose storage it took. */
    taken(snapshot, replacing) {
        this.kept.delete(replacing);
        const cycle = snapshotCycle(this.cpu, snapshot);
        if ([...this.kept].some((kept) => snapshotCycle(this.cpu, kept) > cycle)) this.restart();
        this.kept.add(snapshot);
    }

    /** Forgets every snapshot and input so far, the machine's state having been replaced. */
    restart() {
        this.kept.clear();
        this.log.restart();
    }

    /** Forgets inputs from before the oldest snapshot a replay can start from. */
    trim() {
        if (this.log.isEmpty) return;
        const [oldest] = this.snapshots();
        if (oldest) this.log.trimBefore(snapshotCycle(this.cpu, oldest));
    }

    /** The snapshots a replay can start from, oldest first. */
    snapshots() {
        const cycle = (snapshot) => snapshotCycle(this.cpu, snapshot);
        return [...this.kept].sort((a, b) => cycle(a) - cycle(b));
    }

    _earlier(now) {
        return this.snapshots().filter((snapshot) => snapshotCycle(this.cpu, snapshot) < now);
    }

    /** Why `what`, a replay of the machine's history, cannot be done from where it is; `nothing` if it has none. */
    _unavailable(what, nothing) {
        const { cpu } = this;
        if (cpu.econet) return `${what} is not available with Econet, whose network a replay cannot repeat.`;
        if (cpu.tapeInterface.motorOn) return `${what} is not available while the cassette motor runs.`;
        return this._earlier(cycleCount(cpu)).length ? null : nothing;
    }

    /** Why the machine cannot step back from where it is, or null if it can. */
    refusal() {
        const { cpu } = this;
        const unavailable = this._unavailable("Step back", NothingToStepBackTo);
        if (unavailable) return unavailable;
        const now = cycleCount(cpu);
        const crossing = this.log.refusalBetween(snapshotCycle(cpu, this._earlier(now).at(-1)), now);
        return crossing && `Step back cannot go back past ${crossing}.`;
    }

    /**
     * Replays the stretches between the snapshots before now, newest first, each checked to end on the machine it
     * is replayed towards (the state now or the next snapshot's), until `seeker` finds in one what it looks for,
     * yielding after each stretch that does not have it. A seeker replays each stretch with its `hooks`, is told of
     * each with `startWindow(from)`, says with `inWindow(to)` what it found there or null, and with
     * `searches(from)` whether a stretch from `from` is worth replaying. Returns
     * `{ found, snapshot, reached, stoppedBy }`: what it found, or null, and the snapshot of the stretch it was found
     * in; the cycle the search reached back to; and
     * why it went no further, null if it ran out of stretches or `seeker` wanted none older: something no replay
     * crosses, or Unrepeated. Leaves the machine at the end of whichever stretch it replayed last.
     */
    *_searchBack(seeker) {
        const { cpu, log } = this;
        let [to, hash, inputsAtTo] = [cycleCount(cpu), stateHash(cpu), true];
        for (const snapshot of this._earlier(to).reverse()) {
            const from = snapshotCycle(cpu, snapshot);
            // A rewind snapshot is a copy of a frame snapshot, at the same cycle, and has nothing to replay.
            if (from === to) continue;
            if (!seeker.searches(from)) break;
            const crossing = log.refusalBetween(from, to);
            if (crossing) return { found: null, snapshot: null, reached: to, stoppedBy: crossing };
            seeker.startWindow(from);
            const fromHash = log.replay(snapshot, to, inputsAtTo, seeker.hooks);
            if (fromHash === null || stateHash(cpu) !== hash)
                return { found: null, snapshot: null, reached: to, stoppedBy: Unrepeated };
            const found = seeker.inWindow(to);
            if (found !== null) return { found, snapshot, reached: from, stoppedBy: null };
            [to, hash, inputsAtTo] = [from, fromHash, false];
            yield;
        }
        return { found: null, snapshot: null, reached: to, stoppedBy: null };
    }

    _original() {
        const { cpu } = this;
        const { memStatOffset } = cpu;
        return { state: cpu.snapshotState(), host: hostInputs(cpu), picture: cpu.video.fb32.slice(), memStatOffset };
    }

    /**
     * Puts the machine, the host's inputs and the picture back as `_original` kept them, with the half of the paging
     * tables the last instruction's fetch chose, which a snapshot leaves out.
     */
    _putBack({ state, host, picture, memStatOffset }) {
        const { cpu } = this;
        this.log.withoutRecording(() => {
            restoreHostInputs(cpu, host);
            cpu.restoreState(state);
        });
        cpu.video.fb32.set(picture);
        cpu.memStatOffset = memStatOffset;
    }

    // Steps back to the cycle `seeker` finds, or returns why it could not, `notFound` if no stretch held one.
    _stepBackFinding(seeker, notFound) {
        return finished(
            this._steppingBack(seeker, (stoppedBy) => {
                if (stoppedBy === Unrepeated) return NotRepeated;
                return stoppedBy ? `Step back cannot go back past ${stoppedBy}.` : notFound;
            }),
        );
    }

    /**
     * Runs `_searchBack(seeker)` a stretch at a time, painting none of it, putting the machine back as `original`
     * keeps it between stretches and yielding there. Returns what the search returns, with the machine where its
     * last stretch left it, or `{ movedOn: true }` if the machine has moved on when the search resumes.
     */
    *_searchingAway(seeker, original) {
        const { cpu } = this;
        const [now, nowHash] = [cycleCount(cpu), stateHash(cpu)];
        const search = this._searchBack(seeker);
        for (;;) {
            let step;
            try {
                step = withoutPainting(cpu.video, () => search.next());
            } catch (e) {
                this._putBack(original);
                throw e;
            }
            if (step.done) return step.value;
            this._putBack(original);
            yield;
            if (cycleCount(cpu) !== now || stateHash(cpu) !== nowHash) return { movedOn: true };
        }
    }

    /**
     * Steps back to the cycle `seeker` finds, searching back a stretch at a time as lastWrite does, painting none of
     * it, and yielding between stretches with the machine as it was; if the machine has moved on when it resumes,
     * it stops. Returns why it could not, having left the machine and its picture as they were, or null. If no
     * stretch held what it seeks, `unfound(stoppedBy, searched)` says why, with `stoppedBy` what no replay crosses
     * (Unrepeated among them), or null where the history ends, and `searched` how many cycles back from now it
     * looked.
     */
    *_steppingBack(seeker, unfound) {
        const refused = this.refusal();
        if (refused) return refused;
        const now = cycleCount(this.cpu);
        const original = this._original();
        const { movedOn, found, snapshot, reached, stoppedBy } = yield* this._searchingAway(seeker, original);
        if (movedOn) return MovedOn;
        let landed = false;
        try {
            if (stoppedBy === Unrepeated && reached === now) return NotRepeated;
            if (found === null) return unfound(stoppedBy, now - reached);
            if (this.log.replay(snapshot, found, true, NoReplayHooks) === null) return NotRepeated;
            landed = true;
            this._landedAt(found, original.host);
            return null;
        } finally {
            if (!landed) this._putBack(original);
        }
    }

    /** Says that `what` was found nowhere in the cycles searched, and why the search stopped, as `unfound` does. */
    _searchedFor(what) {
        return (stoppedBy, searched) => {
            const ago = `${searched} cycles (${durationText(searched / this.cpu.model.cyclesPerSecond)})`;
            const why = stoppedBy ? `cannot go back past ${stoppedBy}` : "that is as far back as the history goes";
            return `${what} in the last ${ago}, and ${why}.`;
        };
    }

    /**
     * Steps the machine back one instruction, or with `over` back over the call the instruction before returned
     * from, by replaying from the newest snapshot before it (older ones too, for a call further back). Each
     * stretch replayed must end on the machine it is replayed towards, the state now or the next snapshot, or
     * nothing is trusted. What the host holds now (keys, FIRE buttons, BREAK) it holds where the machine lands.
     * Returns why it could not, having left the machine and its picture as they were, or null.
     */
    stepBack(over) {
        return this._stepBackFinding(new Landing(this.cpu, over), NoCallFound);
    }

    /**
     * Steps the machine back to the call or interrupt that entered the routine it is in, a stretch at a time as
     * `_steppingBack` does.
     */
    *stepBackOut() {
        return yield* this._steppingBack(
            new OutLanding(this.cpu),
            this._searchedFor("Step back out found no call or interrupt that entered this routine"),
        );
    }

    /** Steps the machine back to `cycle`, an instruction boundary since its oldest snapshot, as stepBack does. */
    stepBackTo(cycle) {
        if (cycle >= cycleCount(this.cpu)) return NotBehind;
        return this._stepBackFinding(new Arrival(cycle), TooFarBack);
    }

    /**
     * Searches for the last write to `address`, as the machine pages it now (see LastWrite), by replaying its
     * history back from now a stretch at a time, as a step back does, painting none of it. Yields between
     * stretches, with the machine as it was, so that a long search can let the page go on; if the machine has moved
     * on when it resumes, it stops.
     * Returns `{ refusal }` when it cannot search (ROM, which no write changes, among the reasons), or else
     * `{ write, searched, stoppedBy }`: `write` is `{ pc, cycle, value }`, `cycle` where the instruction at `pc`
     * started, or with `pc` null where an input such as a memory panel edit wrote it, or null if nothing wrote it in
     * the `searched` cycles back from now; `stoppedBy` is why the search went back no further (as `_searchBack`
     * gives it), or null where the history ends. Leaves the machine as it was.
     */
    *lastWrite(address) {
        const refusal = this._unavailable("Searching back", NothingToSearch);
        if (refusal) return { refusal };
        const { cpu, log } = this;
        if (cpu.memStat[cpu.memStatOffset + (address >>> 8)] === RomStat) return { refusal: IsRom };
        const now = cycleCount(cpu);
        const original = this._original();
        const { movedOn, found, reached, stoppedBy } = yield* this._searchingAway(
            new LastWrite(cpu, log, address),
            original,
        );
        if (movedOn) return { refusal: MovedOn };
        this._putBack(original);
        if (stoppedBy && reached === now) {
            return { refusal: stoppedBy === Unrepeated ? NotRepeatedHere : `${CannotSearchPast} ${stoppedBy}.` };
        }
        return { write: found, searched: now - reached, stoppedBy };
    }

    // What came after `cycle` was a future the machine has left, and runs from here make their own.
    _landedAt(cycle, holding) {
        this.log.forgetAfter(cycle);
        const forgotten = new Set([...this.kept].filter((snapshot) => snapshotCycle(this.cpu, snapshot) > cycle));
        for (const snapshot of forgotten) this.kept.delete(snapshot);
        for (const input of hostChanges(hostInputs(this.cpu), holding)) {
            this.log.record(input);
            this.log.withoutRecording(() => applyInput(this.cpu, input));
        }
        this.dispatchEvent(new CustomEvent("landed", { detail: { forgotten } }));
    }
}
