import { describe, expect, it } from "vitest";

import { finished, ReplayHistory, snapshotCycle } from "../../src/replay.js";
import { cycleCount } from "../../src/lockstep.js";
import { snapshotToJSON } from "../../src/snapshot.js";
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

const WriterAt = 0x2000;
const Written = 0x3000;
const WrittenValue = 0x42;
const IdleAt = WriterAt + 3;
// STA $3000, then NOP and JMP back to it for ever, A holding $42.
const WriteThenIdle = [0x8d, 0x00, 0x30, 0xea, 0x4c, IdleAt & 0xff, IdleAt >>> 8];
const EditedValue = 0x99;
const SomeCycles = 5000;
const Acccon = 0xfe34;
const AccconShadow = 0x04;
const MainWriteAt = 0x2000;
// On a Master: $11 to $3000 in main RAM, $22 to $3000 in shadow RAM, then main again, and idle.
const MainThenShadowThenIdle = [
    ...[0xa9, 0x11, 0x8d, 0x00, 0x30],
    ...[0xa9, AccconShadow, 0x8d, Acccon & 0xff, Acccon >>> 8, 0xa9, 0x22, 0x8d, 0x00, 0x30],
    ...[0xa9, 0x00, 0x8d, Acccon & 0xff, Acccon >>> 8],
];
const ShadowIdleAt = MainWriteAt + MainThenShadowThenIdle.length;
const JmpToItself = [0x4c, ShadowIdleAt & 0xff, ShadowIdleAt >>> 8];
const TestRefusal = "a refusal the test made";
const UserViaDdrb = 0xfe62;
const RomAddress = 0xc000;

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

function runFor(cpu, cycles) {
    cpu.targetCycles = cpu.currentCycles;
    cpu.execute(cycles);
}

const take = (history) => history.taken(history.cpu.snapshotState(), null);
const takeAndRun = (history) => {
    take(history);
    runFor(history.cpu, SomeCycles);
};
const writeAndIdle = (cpu) => runTo(cpu, IdleAt);
const instructionWrite = { pc: WriterAt, value: WrittenValue };

describe("Finding the last write to a byte", () => {
    it.each([
        [
            "in the newest stretch",
            (cpu, history) => {
                take(history);
                writeAndIdle(cpu);
            },
            { write: instructionWrite, stoppedBy: null },
        ],
        [
            "in an older stretch",
            (cpu, history) => {
                take(history);
                writeAndIdle(cpu);
                take(history);
                runFor(cpu, SomeCycles);
            },
            { write: instructionWrite, stoppedBy: null },
        ],
        [
            "by a memory panel edit",
            (cpu, history) => {
                take(history);
                writeAndIdle(cpu);
                runFor(cpu, SomeCycles);
                history.log.record({ kind: "write", address: Written, value: EditedValue });
                cpu.writemem(Written, EditedValue);
                runFor(cpu, SomeCycles);
            },
            { write: { pc: null, value: EditedValue }, stoppedBy: null },
        ],
        [
            "nowhere the history reaches",
            (cpu, history) => {
                writeAndIdle(cpu);
                take(history);
                runFor(cpu, SomeCycles);
            },
            { write: null, stoppedBy: null, searchedFrom: 0 },
        ],
        [
            "nowhere a search can reach, past a refusal",
            (cpu, history) => {
                take(history);
                writeAndIdle(cpu);
                history.log.refuse(TestRefusal);
                runFor(cpu, SomeCycles);
                take(history);
                runFor(cpu, SomeCycles);
            },
            { write: null, stoppedBy: TestRefusal, searchedFrom: 1 },
        ],
    ])("is found %s, leaving the machine be", async (_, run, expected) => {
        const cpu = await machineAt(WriterAt, {});
        loadBytes(cpu, WriterAt, WriteThenIdle);
        cpu.a = WrittenValue;
        const history = new ReplayHistory(cpu);
        run(cpu, history);
        const before = snapshotToJSON(cpu.snapshotState());
        const { write, searched, stoppedBy } = finished(history.lastWrite(Written));
        expect(snapshotToJSON(cpu.snapshotState())).toEqual(before);
        expect(stoppedBy).toBe(expected.stoppedBy);
        if (expected.write === null) {
            expect(write).toBeNull();
            const [from] = history.snapshots().slice(expected.searchedFrom);
            expect(searched).toBe(cycleCount(cpu) - snapshotCycle(cpu, from));
            return;
        }
        expect(write).toMatchObject(expected.write);
        if (write.pc === null) return;
        expect(history.stepBackTo(write.cycle)).toBeNull();
        expect(cpu.pc).toBe(WriterAt);
        singleStep(cpu);
        expect(cpu.peekmem(Written)).toBe(WrittenValue);
    });

    it.each([
        [
            "on a Master, the main RAM's, not the shadow RAM's a later write at the address reached",
            "Master",
            [...MainThenShadowThenIdle, ...JmpToItself],
            Written,
            { pc: MainWriteAt + 2, value: 0x11 },
        ],
        [
            "a device register's, as written to its address",
            "B-DFS1.2",
            [0xa9, 0x5a, 0x8d, UserViaDdrb & 0xff, UserViaDdrb >>> 8, ...JmpToItself],
            UserViaDdrb,
            { pc: MainWriteAt + 2, value: 0x5a },
        ],
    ])("is of the byte as the CPU pages it now: %s", async (_, model, code, address, expected) => {
        const cpu = await machineAt(MainWriteAt, { model: findModel(model) });
        loadBytes(cpu, MainWriteAt, code);
        const history = new ReplayHistory(cpu);
        take(history);
        runTo(cpu, MainWriteAt + code.length - JmpToItself.length);
        expect(finished(history.lastWrite(address)).write).toMatchObject(expected);
    });

    it.each([
        ["with no history to search", () => {}, (history) => history.lastWrite(Written), /no history to search/],
        ["of ROM", takeAndRun, (history) => history.lastWrite(RomAddress), /That is ROM/],
        [
            "when the run since the newest snapshot cannot be repeated",
            (history) => {
                takeAndRun(history);
                history.cpu.writemem(Written, EditedValue);
            },
            (history) => history.lastWrite(Written),
            /could not repeat/,
        ],
    ])("refuses a search %s, leaving the machine be", async (_, set, search, why) => {
        const cpu = await machineAt(WriterAt, { model: findModel("B-DFS1.2") });
        loadBytes(cpu, WriterAt, WriteThenIdle);
        const history = new ReplayHistory(cpu);
        set(history);
        const before = snapshotToJSON(cpu.snapshotState());
        expect(finished(search(history)).refusal).toMatch(why);
        expect(snapshotToJSON(cpu.snapshotState())).toEqual(before);
    });

    it.each([
        ["now or later", (cpu) => cycleCount(cpu), /not before where the machine is now/],
        ["before the oldest snapshot", (cpu, before) => before, /further back than the machine keeps/],
    ])("refuses a step back to a cycle %s", async (_, cycle, why) => {
        const cpu = await machineAt(WriterAt, {});
        loadBytes(cpu, WriterAt, WriteThenIdle);
        const before = cycleCount(cpu);
        runFor(cpu, SomeCycles);
        const history = new ReplayHistory(cpu);
        take(history);
        runFor(cpu, SomeCycles);
        expect(history.stepBackTo(cycle(cpu, before))).toMatch(why);
    });

    it("stops, as it was left between stretches, once the machine has moved on", async () => {
        const cpu = await machineAt(WriterAt, {});
        loadBytes(cpu, WriterAt, WriteThenIdle);
        const history = new ReplayHistory(cpu);
        writeAndIdle(cpu);
        take(history);
        runFor(cpu, SomeCycles);
        take(history);
        runFor(cpu, SomeCycles);
        const before = snapshotToJSON(cpu.snapshotState());
        const search = history.lastWrite(Written);
        expect(search.next().done).toBe(false);
        expect(snapshotToJSON(cpu.snapshotState())).toEqual(before);
        runFor(cpu, SomeCycles);
        expect(search.next().value.refusal).toMatch(/moved on/);
    });
});

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
