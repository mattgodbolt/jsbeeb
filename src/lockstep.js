// Deterministic lockstep for a shared session: every machine starts from the
// host's snapshot and applies the same inputs at the same emulated cycle, so
// they stay identical without sending any machine state. The host is the
// sequencer; its machine runs as normal, and what it executes, and the inputs it
// applied between executes, go out as commits that guests replay exactly. See
// docs/shared-sessions-design.md.

import { Disc, DiscConfig } from "./disc.js";
import { KeyMatrixSize } from "./via.js";

const HashIntervalSeconds = 1;
// A guest more than this far behind the host's commits runs faster to catch up,
// by at most the second figure in any one call, so a long way behind is not one long stall.
export const MaxGuestLagSeconds = 0.25;
export const MaxCatchUpSeconds = 0.1;
const FnvOffset = 0x811c9dc5;
const FnvPrime = 0x01000193;
const MsPerMinute = 60 * 1000;

/**
 * The emulated cycle the machine has reached, counted from power on. Between
 * executes it is an instruction boundary, which is what makes it a place another
 * machine running the same code can stop at exactly.
 */
export function cycleCount(cpu) {
    return cpu.cycleSeconds * cpu.model.cyclesPerSecond + cpu.currentCycles;
}

function targetCount(cpu) {
    return cpu.cycleSeconds * cpu.model.cyclesPerSecond + cpu.targetCycles;
}

// The CPU runs whole instructions until it reaches its target, so asking for a
// cycle that some machine stopped at lands on it exactly.
function runTo(cpu, cycle) {
    return cpu.execute(cycle - targetCount(cpu));
}

const cyclesToMs = (cpu, cycles) => (cycles * 1000) / cpu.model.cyclesPerSecond;

/**
 * Gives the machine the session's CMOS, whose clock reads `baseMs` plus the machine's
 * emulated cycles: the same time on every machine in the session.
 */
function joinSessionCmos(cpu, cmosState, baseMs) {
    cpu.sysvia.cmos.joinSession(cmosState, () => baseMs + cyclesToMs(cpu, cycleCount(cpu)));
}

function fnv1a(hash, bytes) {
    for (let i = 0; i < bytes.length; ++i) hash = Math.imul(hash ^ bytes[i], FnvPrime);
    return hash;
}

/** A cheap fingerprint of the machine for desync detection: registers, RAM and the keyboard. */
export function stateHash(cpu) {
    const registers = Uint8Array.of(cpu.a, cpu.x, cpu.y, cpu.s, cpu.pc & 0xff, cpu.pc >>> 8, cpu.p.asByte());
    let hash = fnv1a(FnvOffset, registers);
    hash = fnv1a(hash, cpu.ramRomOs.subarray(0, cpu.romOffset));
    for (const column of cpu.sysvia.keys) hash = fnv1a(hash, column);
    return (hash >>> 0).toString(16);
}

export function applyInput(cpu, input) {
    switch (input.kind) {
        case "key":
            cpu.sysvia.setMapped(input.mapping, input.down ? 1 : 0);
            break;
        case "break":
            cpu.setReset(input.down);
            break;
        default:
            throw new Error(`Unknown session input "${input.kind}"`);
    }
}

/** Checks an input from a peer has the shape applyInput expects, so a bad one cannot throw in a machine's loop. */
export function isValidInput(input) {
    if (input?.kind === "break") return typeof input.down === "boolean";
    if (input?.kind !== "key" || typeof input.down !== "boolean" || !Array.isArray(input.mapping)) return false;
    const [col, row, shiftOverride] = input.mapping;
    const inMatrix = (n) => Number.isInteger(n) && n >= 0 && n < KeyMatrixSize;
    return (
        input.mapping.length <= 3 &&
        inMatrix(col) &&
        inMatrix(row) &&
        (shiftOverride === undefined || typeof shiftOverride === "boolean")
    );
}

export function isValidCommit(commit) {
    return (
        Number.isInteger(commit?.at) &&
        Number.isInteger(commit.upTo) &&
        commit.upTo >= commit.at &&
        Array.isArray(commit.inputs) &&
        commit.inputs.every(isValidInput) &&
        (commit.hash === undefined || typeof commit.hash === "string")
    );
}

/**
 * Makes `cpu` the machine a session snapshot describes. A drive restores tracks only into
 * a disc it already holds, which may be this person's own and write back to where it came
 * from, so each drive first gets a fresh disc of its own, or none if the host's is empty.
 * The CMOS joins the session before the machine is restored, so the bus accesses the
 * restore makes reach the session's CMOS and never this person's stored settings.
 */
export function restoreSessionSnapshot(cpu, snapshot) {
    const { state, keyboard, at, cmos, rtcBaseMs } = snapshot;
    cpu.fdc.drives.forEach((drive, index) => {
        drive.setDisc(state.fdc?.drives?.[index]?.disc ? new Disc(true, new DiscConfig(), "") : undefined);
    });
    joinSessionCmos(cpu, cmos, rtcBaseMs);
    cpu.restoreState(state);
    cpu.sysvia.restoreKeyboard(keyboard);
    if (cycleCount(cpu) !== at) throw new Error(`restored to cycle ${cycleCount(cpu)}, not ${at}`);
}

/**
 * The host's side. Wraps the machine's execute: inputs queued since the last
 * execute are applied at the cycle the machine has reached, then the machine
 * runs, and the commit describing both goes to `send`. If the machine is found
 * somewhere other than where the last execute left it (a hard reset zeroes the
 * cycle count, a loaded state moves it anywhere), `onJump` is told before the
 * next commit, since no guest can follow that by replaying.
 *
 * The host also keeps the session's clock: its RTC reads its wall time at `rtcBaseMs`
 * plus emulated cycles, starting again from the wall time after a jump.
 */
export class LockstepHost {
    constructor(cpu, send, onJump, { rtcBaseMs } = {}) {
        this.cpu = cpu;
        this.send = send;
        this.onJump = onJump;
        this.pending = [];
        this.hashInterval = HashIntervalSeconds * cpu.model.cyclesPerSecond;
        this.reachedAt = cycleCount(cpu);
        this.nextHashAt = this.reachedAt + this.hashInterval;
        this.startClock(rtcBaseMs);
    }

    // The wall time here, as a clock read in UTC shows it, at cycle zero.
    startClock(rtcBaseMs) {
        const { cpu } = this;
        const wallMs = Date.now() - new Date().getTimezoneOffset() * MsPerMinute;
        this.rtcBaseMs = rtcBaseMs ?? wallMs - cyclesToMs(cpu, cycleCount(cpu));
        joinSessionCmos(cpu, cpu.sysvia.cmos.sessionState(), this.rtcBaseMs);
    }

    /** What a joiner needs to become this machine, which ordinary snapshots leave part of out. */
    snapshot() {
        const { cpu } = this;
        return {
            state: cpu.snapshotState({ includeRoms: true }),
            keyboard: cpu.sysvia.keyboardState(),
            at: cycleCount(cpu),
            cmos: cpu.sysvia.cmos.sessionState(),
            rtcBaseMs: this.rtcBaseMs,
        };
    }

    input(input) {
        this.pending.push(input);
    }

    execute(cycles) {
        const { cpu } = this;
        const at = cycleCount(cpu);
        if (at !== this.reachedAt) {
            this.nextHashAt = at + this.hashInterval;
            this.startClock();
            this.onJump();
        }
        const inputs = this.pending.splice(0);
        for (const input of inputs) applyInput(cpu, input);
        const running = cpu.execute(cycles);
        const upTo = cycleCount(cpu);
        this.reachedAt = upTo;
        const commit = { type: "commit", at, inputs, upTo };
        if (upTo >= this.nextHashAt) {
            commit.hash = stateHash(cpu);
            this.nextHashAt = upTo + this.hashInterval;
        }
        this.send(commit);
        return running;
    }
}

/**
 * A guest's side. Commits from the host queue up; execute replays them, running
 * no further than the host has, applying each input at the cycle it was applied
 * at and checking the host's hashes where they were taken. `onDesync` is called
 * once when this machine and the host's part, and not again until `resync`.
 */
export class LockstepGuest {
    constructor(cpu, onDesync) {
        this.cpu = cpu;
        this.onDesync = onDesync;
        this.maxLag = MaxGuestLagSeconds * cpu.model.cyclesPerSecond;
        this.maxCatchUp = MaxCatchUpSeconds * cpu.model.cyclesPerSecond;
        this.resync();
    }

    /** Starts again from the machine as it is now, having been given the host's. */
    resync() {
        this.commits = [];
        this.upTo = this.reachedAt = cycleCount(this.cpu);
        this.desynced = false;
    }

    /** Takes the host's next commit, which must start where the last one ended. */
    receive(commit) {
        if (commit.at !== this.upTo) {
            this.desync(`the host's commit starts at ${commit.at}, not ${this.upTo}`);
            return;
        }
        this.commits.push(commit);
        this.upTo = commit.upTo;
    }

    /** How many cycles the host is ahead of this machine. */
    behind() {
        return this.upTo - cycleCount(this.cpu);
    }

    /**
     * Runs about `cycles`, more if far behind the host, never past the host. Returns
     * false if the machine stopped (as `cpu.execute` does).
     */
    execute(cycles) {
        const { cpu } = this;
        if (cycleCount(cpu) !== this.reachedAt) this.desync(`this machine moved from ${this.reachedAt} by itself`);
        const running = this.replay(cycles);
        this.reachedAt = cycleCount(cpu);
        return running;
    }

    replay(cycles) {
        const { cpu } = this;
        const catchUp = Math.min(this.behind() - this.maxLag, this.maxCatchUp);
        const limit = Math.min(this.upTo, cycleCount(cpu) + Math.max(cycles, catchUp));
        while (this.commits.length > 0) {
            const commit = this.commits[0];
            if (commit.at > limit) break;
            if (!runTo(cpu, commit.at)) return false;
            if (commit.inputs.length > 0) {
                if (cycleCount(cpu) !== commit.at) return this.desync(`reached ${cycleCount(cpu)} for ${commit.at}`);
                for (const input of commit.inputs) applyInput(cpu, input);
                commit.inputs = [];
            }
            if (commit.upTo > limit) break;
            if (!runTo(cpu, commit.upTo)) return false;
            this.commits.shift();
            if (commit.hash !== undefined && stateHash(cpu) !== commit.hash) {
                return this.desync(`state differs from the host's at cycle ${commit.upTo}`);
            }
        }
        return runTo(cpu, limit);
    }

    desync(reason) {
        this.commits = [];
        if (!this.desynced) {
            this.desynced = true;
            this.onDesync(reason);
        }
        return true;
    }
}
