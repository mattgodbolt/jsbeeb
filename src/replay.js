// Stepping the machine backwards: it is put back to a snapshot from before where it is to go, and run forward to
// there exactly. Snapshots leave out what the host gives the machine (keys, FIRE buttons, BREAK, a debugger's
// edits) and what the machine reads from the host as it runs (the analogue channels, the clock, the touchscreen),
// so an InputLog records both as they happen, and a replay puts each back where it went in or was read.

import { applyInput, cycleCount, stateHash } from "./lockstep.js";
import { tickCycles } from "./emulation-tick.js";

// How far back step back over looks for the call it is to land on, past which the wait is not worth it.
const LongestCallSearchSeconds = 2;

const NothingToStepBackTo =
    "There is nothing to step back to: the machine keeps its history once it has run a frame since it started, " +
    "was reset or had its state replaced.";
const NotRepeated = "Step back could not repeat the machine's run exactly, so the machine is left where it was.";
const NoCallFound = `Step back over found no call this returned from in the last ${LongestCallSearchSeconds} seconds.`;
const NoStepBackWithEconet = "Step back is not available with Econet, whose network a replay cannot repeat.";
const NoStepBackWithTapeRunning = "Step back is not available while the cassette motor runs.";
const MidInstruction = "an input that came part way through an instruction, as a paste's or an autotype's keys do";

// S counts down and wraps, so "not deeper" is a difference of under half the page, either way round $00.
export function notDeeper(s, startS) {
    return ((s - startS) & 0xff) < 0x80;
}

export const snapshotCycle = (cpu, snapshot) =>
    snapshot.cycleSeconds * cpu.model.cyclesPerSecond + snapshot.currentCycles;

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
        this.replaying = null;
        this.recording = true;
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
        if (this.replaying) return this.replaying.read(key, cycleCount(this.cpu), value);
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
     * Puts the machine back to `snapshot` and runs it to `to`, with every debug hook detached but `onInstruction`
     * (as `withOnlyInstructionHook` takes), putting each input back at its cycle, those at `to` too if
     * `inputsAtTo`. Returns the hash of the machine as the snapshot put it, or null if the replay did not reach
     * an input's cycle or `to` exactly.
     */
    replay(snapshot, to, inputsAtTo, onInstruction) {
        const { cpu } = this;
        const from = snapshotCycle(cpu, snapshot);
        this.recording = false;
        this.replaying = new SampleReplay(this.samples, from, this.samplesAt(from));
        try {
            restoreHostInputs(cpu, this.hostAt(from));
            cpu.restoreState(snapshot);
            cpu.debugInstruction.forgetStop();
            const startHash = stateHash(cpu);
            const reached = cpu.withOnlyInstructionHook(onInstruction, () => {
                for (const { at, input } of this.inputs) {
                    if (at < from || !input) continue;
                    if (at > to || (at === to && !inputsAtTo)) break;
                    if (!runTo(cpu, at) || cycleCount(cpu) !== at) return false;
                    applyInput(cpu, input);
                }
                return runTo(cpu, to) && cycleCount(cpu) === to;
            });
            return reached ? startHash : null;
        } finally {
            this.replaying = null;
            this.recording = true;
        }
    }
}

/**
 * Where a step back lands, worked out from the instructions replays pass the start of, a window at a time from
 * the newest. Back one, it is the last instruction of the first window. Back over, it is the same unless that
 * instruction returned to here (a return with the stack shallower after it); then it is the last instruction
 * before it at a stack no deeper than here, the call that return came back from, in whichever window has one.
 */
class Landing {
    constructor(cpu, over) {
        this.cpu = cpu;
        this.over = over;
        this.s = cpu.s;
        this.seekingCall = false;
        this.onInstruction = (_pc, opcode) => this.passing(opcode);
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

    /** Why the machine cannot step back from where it is, or null if it can. */
    refusal() {
        const { cpu } = this;
        if (cpu.econet) return NoStepBackWithEconet;
        if (cpu.acia.motorOn) return NoStepBackWithTapeRunning;
        const now = cycleCount(cpu);
        const from = this._earlier(now).at(-1);
        if (!from) return NothingToStepBackTo;
        return this._crossing(snapshotCycle(cpu, from), now);
    }

    _crossing(from, to) {
        const refusal = this.log.refusalBetween(from, to);
        return refusal && `Step back cannot go back past ${refusal}.`;
    }

    /**
     * Steps the machine back one instruction, or with `over` back over the call the instruction before returned
     * from, by replaying from the newest snapshot before it (older ones too, for a call further back). Each
     * stretch replayed must end on the machine it is replayed towards, the state now or the next snapshot, or
     * nothing is trusted. What the host holds now (keys, FIRE buttons, BREAK) it holds where the machine lands.
     * Returns why it could not, having left the machine and its picture as they were, or null.
     */
    stepBack(over) {
        const { cpu, log } = this;
        const refused = this.refusal();
        if (refused) return refused;
        const now = cycleCount(cpu);
        const original = { state: cpu.snapshotState(), host: hostInputs(cpu), picture: cpu.video.fb32.slice() };
        const searchFrom = now - LongestCallSearchSeconds * cpu.model.cyclesPerSecond;
        const landing = new Landing(cpu, over);
        let [to, hash, inputsAtTo] = [now, stateHash(cpu), true];
        let landed = false;
        try {
            for (const snapshot of this._earlier(now).reverse()) {
                const from = snapshotCycle(cpu, snapshot);
                if (landing.seekingCall && from < searchFrom) break;
                const crossing = this._crossing(from, to);
                if (crossing) return crossing;
                landing.startWindow();
                const fromHash = log.replay(snapshot, to, inputsAtTo, landing.onInstruction);
                if (fromHash === null || stateHash(cpu) !== hash) return NotRepeated;
                const target = landing.inWindow();
                if (target !== null) {
                    if (log.replay(snapshot, target, true, null) === null) return NotRepeated;
                    landed = true;
                    this._landedAt(target, original.host);
                    return null;
                }
                [to, hash, inputsAtTo] = [from, fromHash, false];
            }
            return NoCallFound;
        } finally {
            if (!landed) {
                log.withoutRecording(() => {
                    restoreHostInputs(cpu, original.host);
                    cpu.restoreState(original.state);
                });
                cpu.video.fb32.set(original.picture);
            }
        }
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
