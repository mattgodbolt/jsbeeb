// The instructions the machine ran before now, found by replaying its history.

import { NoReplayHooks } from "./6502.js";
import { cycleCount } from "./lockstep.js";
import { Unrepeated } from "./replay.js";

/** How many instructions, and interrupts taken between them, the debugger's trace shows. */
export const TraceDepth = 1000;

const InstructionBytes = 3;
const Registers = 5;
const Kinds = ["instruction", "irq", "nmi"];
// Indices into Kinds.
const Instruction = 0;
const Irq = 1;
const Nmi = 2;
const NotRepeated = "The trace could not repeat the machine's run exactly.";

/**
 * The last `capacity` instructions a replay passed the start of, and the interrupts it took between them, each with
 * the cycle it came at and the registers then: for an instruction as it began, for an interrupt once taken.
 */
class TraceRing {
    constructor(cpu, capacity) {
        this.cpu = cpu;
        this.capacity = capacity;
        this.count = 0;
        this.cycles = new Float64Array(capacity);
        this.addresses = new Uint16Array(capacity);
        this.kinds = new Uint8Array(capacity);
        this.bytes = new Uint8Array(capacity * InstructionBytes);
        this.registers = new Uint8Array(capacity * Registers);
        this.hooks = {
            ...NoReplayHooks,
            instruction: (pc, opcode) => {
                this._note(Instruction, pc, opcode);
            },
            interrupt: (taken, returnsTo) => {
                this._note(taken === "nmi" ? Nmi : Irq, returnsTo, 0);
            },
        };
    }

    get full() {
        return this.count >= this.capacity;
    }

    // The operands as the CPU pages them now, which is as it fetches them.
    _note(kind, address, opcode) {
        const { cpu } = this;
        const slot = this.count++ % this.capacity;
        this.cycles[slot] = cycleCount(cpu);
        this.addresses[slot] = address;
        this.kinds[slot] = kind;
        const bytes = slot * InstructionBytes;
        this.bytes[bytes] = opcode;
        for (let i = 1; i < InstructionBytes; i++) {
            this.bytes[bytes + i] = kind === Instruction ? cpu.peekmem((address + i) & 0xffff) : 0;
        }
        const registers = slot * Registers;
        this.registers[registers] = cpu.a;
        this.registers[registers + 1] = cpu.x;
        this.registers[registers + 2] = cpu.y;
        this.registers[registers + 3] = cpu.s;
        this.registers[registers + 4] = cpu.p.asByte();
    }

    /** What it holds, oldest first. */
    entries() {
        const length = Math.min(this.count, this.capacity);
        return Array.from({ length }, (_, i) => {
            const slot = (this.count - length + i) % this.capacity;
            const [a, x, y, s, p] = this.registers.subarray(slot * Registers, (slot + 1) * Registers);
            const kind = this.kinds[slot];
            const bytes = this.bytes.slice(slot * InstructionBytes, (slot + 1) * InstructionBytes);
            return {
                kind: Kinds[kind],
                cycle: this.cycles[slot],
                address: this.addresses[slot],
                bytes: kind === Instruction ? [...bytes] : null,
                a,
                x,
                y,
                s,
                p,
            };
        });
    }
}

/**
 * The last `count` instructions the machine ran before now, and the interrupts it took between them, found by
 * replaying the newest stretch of `history` (a ReplayHistory), and one stretch further back each time that gives
 * fewer. Yields between stretches as `replayForward` does, with the machine as it was.
 * Returns `{ refusal }` if it could not replay, or else `{ entries, stoppedBy }`: `entries` oldest first, each
 * `{ kind, cycle, address, bytes, a, x, y, s, p }`, `kind` "instruction", with `address` its own and `bytes` the
 * three from there, or "irq" or "nmi", with `address` where the interrupt returns to and `bytes` null; and
 * fewer than `count` only where the history goes no further back, `stoppedBy` saying why as `replayForward` does.
 */
export function* recentInstructions(history, count) {
    const { cpu } = history;
    const now = cycleCount(cpu);
    let since = now - 1;
    let newer = null;
    for (;;) {
        const ring = new TraceRing(cpu, count);
        const replayed = yield* history.replayForward(since, now, { hooks: ring.hooks });
        if (replayed.refusal) return replayed;
        const { from, stoppedBy } = replayed;
        if (stoppedBy === Unrepeated) return newer ? { entries: newer, stoppedBy } : { refusal: NotRepeated };
        if (ring.full || stoppedBy || from > since) return { entries: ring.entries(), stoppedBy };
        newer = ring.entries();
        since = from - 1;
    }
}
