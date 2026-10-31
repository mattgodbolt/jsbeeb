import { describe, expect, it } from "vitest";

import { ReplayHistory } from "../../src/replay.js";
import { fake6502 } from "../../src/fake6502.js";
import { findModel } from "../../src/models.js";
import { singleStep } from "../helpers/single-step.js";
import { loadBytes } from "./helpers.js";

const CallAt = 0x2000;
const SubroutineAt = 0x3000;
// JSR $3000, and at $3000 about three seconds of delay (17 times round 256 * 256 DEX/BNE) and RTS.
const Call = [0x20, 0x00, 0x30, 0xea];
const LongSubroutine = [0xa9, 0x11, 0x85, 0x70, 0xa0, 0x00, 0xa2, 0x00, 0xca, 0xd0, 0xfd, 0x88, 0xd0, 0xf8, 0xc6];
const LongSubroutineEnd = [0x70, 0xd0, 0xf2, 0x60];
const ReturnAt = SubroutineAt + LongSubroutine.length + LongSubroutineEnd.length - 1;

// A tape that plays forever, giving the PPIA nothing.
const SilentTape = { poll: () => 1000, rewind: () => {} };

async function machineAt(pc, options) {
    const cpu = fake6502(options.model ?? null, options);
    await cpu.initialise();
    cpu.pc = pc;
    return cpu;
}

function runTo(cpu, address) {
    const hook = cpu.debugInstruction.add((pc) => pc === address);
    cpu.targetCycles = cpu.currentCycles;
    while (cpu.execute(cpu.model.cyclesPerSecond));
    hook.remove();
}

describe("ReplayHistory", () => {
    it.each([
        ["with Econet fitted", { econet: true }, () => {}, /Econet/],
        ["while the cassette motor runs", {}, (cpu) => cpu.acia.setMotor(true), /cassette motor runs/],
        [
            "while an Atom's tape plays",
            { model: findModel("Atom") },
            (cpu) => {
                cpu.atomppia.setTape(SilentTape);
                cpu.atomppia.pressPlay();
            },
            /cassette motor runs/,
        ],
    ])("refuses to step back %s", async (_, options, set, why) => {
        const cpu = await machineAt(CallAt, options);
        loadBytes(cpu, CallAt, Call);
        const history = new ReplayHistory(cpu);
        history.taken(cpu.snapshotState(), null);
        set(cpu);
        singleStep(cpu);
        expect(history.stepBack(false)).toMatch(why);
        expect(cpu.pc).toBe(SubroutineAt);
    });

    it("gives up looking for the call it is to step back over more than two seconds back, leaving the machine be", async () => {
        const cpu = await machineAt(CallAt, {});
        loadBytes(cpu, CallAt, Call);
        loadBytes(cpu, SubroutineAt, [...LongSubroutine, ...LongSubroutineEnd]);
        const history = new ReplayHistory(cpu);
        history.taken(cpu.snapshotState(), null);
        runTo(cpu, ReturnAt);
        history.taken(cpu.snapshotState(), null);
        singleStep(cpu);
        expect(cpu.pc).toBe(CallAt + 3);
        expect(history.stepBack(true)).toMatch(/found no call this returned from in the last 2 seconds/);
        expect(cpu.pc).toBe(CallAt + 3);
        expect(history.stepBack(false)).toBeNull();
        expect(cpu.pc).toBe(ReturnAt);
    });
});
