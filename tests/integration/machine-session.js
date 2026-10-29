import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MachineSession } from "../../src/machine-session.js";
import { BBC, keyCodes } from "../../src/keymap.js";
import { ATOM } from "../../src/keymap-atom.js";
import { RepoRoot } from "./helpers.js";
import { BootTimeout, bootedSession } from "../helpers/machine-session.js";

const CyclesPerInterlacedFrame = 40000;
const CyclesPerNonInterlacedFrame = 39936;

// A run stops at the instruction boundary after the paint, so cyclesRun lands
// either side of the frame length by up to one instruction: seven cycles, plus
// the stretching an RMW on the 1MHz bus picks up. Still far inside the 64
// cycles between an interlaced frame and a non-interlaced one.
const MaxOvershootCycles = 16;

function expectCyclesNear(actual, expected) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(MaxOvershootCycles);
}

async function frameAlignedSession() {
    const session = await bootedSession();
    await session.runFrames();
    return session;
}

const Irq1v = 0x204;
const ResetVector = 0xfffc;

function vectorAt(session, address) {
    const [lo, hi] = session.readMemory(address, 2);
    return lo | (hi << 8);
}

async function cyclesOverFrames(session, frames) {
    const before = session.elapsedCycles;
    for (let i = 0; i < frames; i++) await session.runFrames();
    return session.elapsedCycles - before;
}

describe("MachineSession frame stepping", () => {
    let session;

    beforeAll(async () => {
        session = await frameAlignedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    it("advances a single frame", async () => {
        const before = session.frameCount;

        expect(await session.runFrames()).toMatchObject({ framesRun: 1, completed: true });
        expect(session.frameCount).toBe(before + 1);
    });

    it("advances several frames at once", async () => {
        const before = session.frameCount;

        const result = await session.runFrames(3);

        expect(result).toMatchObject({ framesRun: 3, completed: true });
        expectCyclesNear(result.cyclesRun, 3 * CyclesPerInterlacedFrame);
        expect(session.frameCount).toBe(before + 3);
    });

    it("steps whole frames without drifting", async () => {
        expectCyclesNear(await cyclesOverFrames(session, 5), 5 * CyclesPerInterlacedFrame);
    });

    it("leaves no unspent cycles behind for the next run", async () => {
        await session.runFrames();

        const before = session.elapsedCycles;
        await session.runFor(1000);

        expectCyclesNear(session.elapsedCycles - before, 1000);
    });

    it("returns rather than spinning when asked for no frames at all", async () => {
        expect(await session.runFrames(0)).toMatchObject({ framesRun: 0, cyclesRun: 0 });
        expect(await session.runFrames(-1)).toMatchObject({ framesRun: 0, cyclesRun: 0 });
    });

    it("gives up when the machine cannot paint in the cycles allowed", async () => {
        const before = session.frameCount;

        expect(await session.runFrames(1, { maxCycles: 100 })).toMatchObject({ framesRun: 0, completed: false });
        expect(session.frameCount).toBe(before);
    });

    it("stops short when a breakpoint fires", async () => {
        const id = session.addBreakpoint("execute", vectorAt(session, Irq1v));

        const result = await session.runFrames(5);
        const hit = session.hitBreakpoint();
        session.removeBreakpoint(id);

        expect(result.completed).toBe(false);
        expect(result.framesRun).toBeLessThan(5);
        expect(hit).toMatchObject({ id, type: "execute" });
    });
});

describe("MachineSession running for cycles", () => {
    let session;

    beforeAll(async () => {
        session = await frameAlignedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    const breakOnNextInterrupt = () => session.addBreakpoint("execute", vectorAt(session, Irq1v));

    it("reports the cycles it ran", async () => {
        const before = session.elapsedCycles;

        const result = await session.runFor(1000);

        expect(result.completed).toBe(true);
        expect(result.cyclesRun).toBe(session.elapsedCycles - before);
        expectCyclesNear(result.cyclesRun, 1000);
    });

    it("stops short when a breakpoint fires and reports only the cycles run", async () => {
        const id = breakOnNextInterrupt();
        const before = session.elapsedCycles;

        const result = await session.runFor(600000);
        session.removeBreakpoint(id);

        expect(result.completed).toBe(false);
        expect(result.cyclesRun).toBe(session.elapsedCycles - before);
        expect(result.cyclesRun).toBeLessThan(CyclesPerInterlacedFrame);
    });

    it("leaves no unspent cycles behind after a breakpoint stop", async () => {
        const id = breakOnNextInterrupt();
        await session.runFor(600000);
        session.removeBreakpoint(id);

        expectCyclesNear((await session.runFor(1000)).cyclesRun, 1000);
    });
});

describe("MachineSession watching execution", () => {
    const ProgramAddress = 0x2000;
    const Program = [0xa9, 0x01, 0xa2, 0x02, 0xa0, 0x03, 0x60]; // LDA #1, LDX #2, LDY #3, RTS
    const ProgramPcs = [0x2000, 0x2002, 0x2004, 0x2006];
    let session;

    beforeAll(async () => {
        session = await frameAlignedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    afterEach(() => {
        session.clearBreakpoints();
        session.resetBreakpointHits();
    });

    const irqHandler = () => vectorAt(session, Irq1v);

    async function stopAtProgramStart(program = Program, { keepBreakpoint = false } = {}) {
        session.writeMemory(ProgramAddress, program);
        const id = session.addBreakpoint("execute", ProgramAddress);
        await session.type(`CALL &${ProgramAddress.toString(16)}`);
        if (!session.hitBreakpoint()) await session.runFor(CyclesPerInterlacedFrame);
        expect(session.hitBreakpoint().id).toBe(id);
        if (!keepBreakpoint) session.removeBreakpoint(id);
        session.resetBreakpointHits();
    }

    it("logs, lists and changes breakpoints with a range, a condition and a hit count", async () => {
        await stopAtProgramStart();
        const logged = session.addBreakpoint("execute", ProgramPcs[1], { end: ProgramPcs[3], action: "log" });
        const stopping = session.addBreakpoint("execute", ProgramPcs[0], { condition: "A = 1", hitCount: 2 });
        session.updateBreakpoint(stopping, { enabled: false, type: "read", address: 0, kind: "read", start: 0 });

        await session.runFor(CyclesPerInterlacedFrame);

        expect(session.hitBreakpoint()).toBeNull();
        expect(session.drainBreakpointLog().hits.map(({ id, address }) => [id, address])).toEqual(
            ProgramPcs.slice(1).map((address) => [logged, address]),
        );
        expect(session.drainBreakpointLog()).toEqual({ hits: [], dropped: 0 });
        expect(session.listBreakpoints()).toEqual([
            expect.objectContaining({ id: logged, type: "execute", address: ProgramPcs[1], end: ProgramPcs[3] }),
            expect.objectContaining({
                id: stopping,
                type: "execute",
                address: ProgramPcs[0],
                condition: "A = 1",
                hitCount: 2,
                enabled: false,
                hits: 0,
            }),
        ]);
    });

    it("reports the byte a read-modify-write stores, after the 6502's dummy write of the old one", async () => {
        const Counter = 0x1900;
        const IncrementCounter = [0xee, Counter & 0xff, Counter >> 8, 0x60]; // INC &1900, RTS
        session.writeMemory(Counter, [0x41]);
        await stopAtProgramStart(IncrementCounter);
        const id = session.addBreakpoint("write", Counter);

        await session.runFor(CyclesPerInterlacedFrame);

        expect(session.hitBreakpoint()).toEqual({ id, type: "write", address: Counter, value: 0x42 });
    });

    it("keeps running whatever the watcher returns", async () => {
        const remove = session.onExecute(() => true);

        const result = await session.runFor(CyclesPerInterlacedFrame);
        remove();

        expect(result.completed).toBe(true);
    });

    it("stops reporting once removed", async () => {
        const seen = new Set();
        session.onExecute((pc) => seen.add(pc))();

        await session.runFor(CyclesPerInterlacedFrame);

        expect(seen.size).toBe(0);
    });

    it("reports the address runUntilAddress stopped at to a watcher added after", async () => {
        const handler = irqHandler();
        await session.runUntilAddress(handler);
        const pcs = [];
        const remove = session.onExecute((pc) => pcs.push(pc));

        await session.runFor(10);
        remove();

        expect(pcs[0]).toBe(handler);
    });

    it("reports each instruction once across a breakpoint stop and resume", async () => {
        await stopAtProgramStart();
        const pcs = [];
        const remove = session.onExecute((pc) => {
            if (pc >= ProgramAddress && pc < ProgramAddress + Program.length) pcs.push(pc);
        });
        session.addBreakpoint("execute", ProgramPcs[2]);

        const stopped = await session.runFor(CyclesPerInterlacedFrame);
        session.clearBreakpoints();
        await session.runFor(CyclesPerInterlacedFrame);
        remove();

        expect(stopped.completed).toBe(false);
        expect(pcs).toEqual(ProgramPcs);
    });

    it("removes a watcher that removes itself at the address it was added stopped at", async () => {
        const handler = irqHandler();
        await session.runUntilAddress(handler);
        const pcs = [];
        const remove = session.onExecute((pc) => {
            pcs.push(pc);
            if (pc === handler) remove();
        });

        await session.runFor(CyclesPerInterlacedFrame);

        expect(pcs).toEqual([handler]);
    });

    it("reports the restored pc once, and not the one the machine was stopped at before", async () => {
        await stopAtProgramStart();
        const state = session.snapshot();
        session.addBreakpoint("execute", ProgramPcs[2]);
        await session.runFor(CyclesPerInterlacedFrame);
        session.clearBreakpoints();
        const pcs = [];
        const remove = session.onExecute((pc) => {
            if (pc >= ProgramAddress && pc < ProgramAddress + Program.length) pcs.push(pc);
        });

        session.restore(state);
        await session.runFor(CyclesPerInterlacedFrame);
        remove();

        expect(pcs).toEqual(ProgramPcs);
    });

    it("runs on past a breakpoint it was saved at, showing the restored pc to a watcher added since", async () => {
        await stopAtProgramStart(Program, { keepBreakpoint: true });
        const state = session.snapshot();
        await session.runFor(CyclesPerInterlacedFrame);
        const pcs = [];
        const remove = session.onExecute((pc) => pcs.push(pc));

        session.restore(state);
        const result = await session.runFor(CyclesPerInterlacedFrame);
        remove();

        expect(result.completed).toBe(true);
        expect(session.hitBreakpoint()).toBeNull();
        expect(pcs[0]).toBe(ProgramAddress);
    });

    it("stops at a breakpoint at the restored pc of a state saved running", async () => {
        await session.runFor(CyclesPerInterlacedFrame);
        const state = session.snapshot();
        const id = session.addBreakpoint("execute", session.registers().pc);
        expect(await session.runFor(CyclesPerInterlacedFrame)).toEqual({ cyclesRun: 0, completed: false });
        session.resetBreakpointHits();

        session.restore(state);
        const result = await session.runFor(CyclesPerInterlacedFrame);

        expect(result).toEqual({ cyclesRun: 0, completed: false });
        expect(session.hitBreakpoint().id).toBe(id);
    });

    it("propagates an exception from a watcher out of the run and still removes it", async () => {
        const remove = session.onExecute(() => {
            throw new Error("watcher failed");
        });

        await expect(session.runFor(CyclesPerInterlacedFrame)).rejects.toThrow("watcher failed");
        remove();

        expect((await session.runFor(CyclesPerInterlacedFrame)).completed).toBe(true);
    });

    it("lets a breakpoint fire at the address where a watcher removes itself", async () => {
        const handler = irqHandler();
        const id = session.addBreakpoint("execute", handler);
        let removedAt;
        const remove = session.onExecute((pc) => {
            if (pc !== handler) return;
            removedAt = session.elapsedCycles;
            remove();
        });

        const result = await session.runFor(CyclesPerInterlacedFrame);

        expect(result.completed).toBe(false);
        expect(session.hitBreakpoint().id).toBe(id);
        expect(session.elapsedCycles).toBe(removedAt);
    });

    it("lets a breakpoint added after a watcher fire where the watcher removes itself", async () => {
        await stopAtProgramStart();
        const remove = session.onExecute((pc) => {
            if (pc === ProgramPcs[2]) remove();
        });
        const id = session.addBreakpoint("execute", ProgramPcs[2]);

        const result = await session.runFor(CyclesPerInterlacedFrame);

        expect(result.completed).toBe(false);
        expect(session.hitBreakpoint().id).toBe(id);
        session.clearBreakpoints();
        await session.runFor(CyclesPerInterlacedFrame);
    });

    it("can call a remover twice", async () => {
        const remove = session.onExecute(() => {});
        remove();

        expect(() => remove()).not.toThrow();
    });

    it("offers the resumed instruction to a watcher added at the stop, after another removed itself", async () => {
        await stopAtProgramStart();
        const pcs = [];
        let removeAdded;
        const removeFirst = session.onExecute((pc) => {
            if (pc === ProgramPcs[2]) removeFirst();
        });
        const removeAdder = session.onExecute((pc) => {
            if (pc !== ProgramPcs[2]) return;
            removeAdder();
            removeAdded = session.onExecute((seen) => pcs.push(seen));
        });
        session.addBreakpoint("execute", ProgramPcs[2]);

        expect((await session.runFor(CyclesPerInterlacedFrame)).completed).toBe(false);
        session.clearBreakpoints();
        await session.runFor(10);
        removeAdded();

        expect(pcs[0]).toBe(ProgramPcs[2]);
    });

    it.each([
        ["a frame painted", () => session.runFrames(1)],
        [
            "a write breakpoint",
            async () => {
                session.addBreakpoint("write", 0x70);
                session.writeMemory(ProgramAddress, [0x85, 0x70, 0x60]); // STA &70, RTS
                await session.type(`CALL &${ProgramAddress.toString(16)}`);
                if (!session.hitBreakpoint()) await session.runFor(CyclesPerInterlacedFrame);
                expect(session.hitBreakpoint().type).toBe("write");
            },
        ],
    ])("stops at once for a breakpoint added where %s stopped it", async (_name, stop) => {
        await stop();
        session.clearBreakpoints();
        session.resetBreakpointHits();
        const id = session.addBreakpoint("execute", session.registers().pc);

        const result = await session.runFor(CyclesPerInterlacedFrame);

        expect(result).toEqual({ completed: false, cyclesRun: 0 });
        expect(session.hitBreakpoint().id).toBe(id);
    });

    it("does not stop again at the breakpoint it resumes from", async () => {
        await stopAtProgramStart(Program, { keepBreakpoint: true });

        const result = await session.runFor(CyclesPerInterlacedFrame);

        expect(result.completed).toBe(true);
        expect(session.hitBreakpoint()).toBe(null);
    });

    it("stops once for two breakpoints at one address, and records both", async () => {
        await stopAtProgramStart();
        const first = session.addBreakpoint("execute", ProgramPcs[2]);
        const second = session.addBreakpoint("execute", ProgramPcs[2]);

        const stopped = await session.runFor(CyclesPerInterlacedFrame);
        session.removeBreakpoint(first);
        const alsoHit = session.hitBreakpoint();
        session.resetBreakpointHits();
        const resumed = await session.runFor(CyclesPerInterlacedFrame);

        expect(stopped.completed).toBe(false);
        expect(alsoHit.id).toBe(second);
        expect(resumed.completed).toBe(true);
        expect(session.hitBreakpoint()).toBe(null);
    });

    it("does not stop or record a hit for a breakpoint added at the address it is stopped at", async () => {
        await stopAtProgramStart();
        session.addBreakpoint("execute", ProgramAddress);

        const resumed = await session.runFor(CyclesPerInterlacedFrame);

        expect(resumed.completed).toBe(true);
        expect(session.hitBreakpoint()).toBe(null);
    });

    it("fires a write breakpoint on the instruction an execute breakpoint stopped at", async () => {
        const StoreAddress = 0x70;
        const storeProgram = [0xa9, 0x2a, 0x85, StoreAddress, 0x60]; // LDA #42, STA &70, RTS
        await stopAtProgramStart(storeProgram);
        const execute = session.addBreakpoint("execute", ProgramAddress + 2);
        const write = session.addBreakpoint("write", StoreAddress);

        await session.runFor(CyclesPerInterlacedFrame);
        const atStore = session.hitBreakpoint();
        session.resetBreakpointHits();
        await session.runFor(CyclesPerInterlacedFrame);
        const afterStore = session.hitBreakpoint();

        expect(atStore.id).toBe(execute);
        expect(afterStore).toEqual({ id: write, type: "write", address: StoreAddress, value: 42 });
    });

    it("reports the value a zero page read breakpoint saw", async () => {
        const LoadAddress = 0x70;
        await stopAtProgramStart([0xa5, LoadAddress, 0x60]); // LDA &70, RTS
        session.writeMemory(LoadAddress, [42]);
        const read = session.addBreakpoint("read", LoadAddress);

        await session.runFor(CyclesPerInterlacedFrame);

        expect(session.hitBreakpoint()).toEqual({ id: read, type: "read", address: LoadAddress, value: 42 });
    });

    it("does not report the address it was added stopped at once reset moves the pc", async () => {
        const handler = irqHandler();
        await session.runUntilAddress(handler);
        const pcs = [];
        const remove = session.onExecute((pc) => pcs.push(pc));

        session.reset();
        await session.runFor(100);
        remove();

        expect(pcs[0]).toBe(vectorAt(session, ResetVector));
        expect(pcs).not.toContain(handler);
    });
});

describe("MachineSession breakpoints across a reset", () => {
    it("stops again at the reset address after a reset while stopped there", async () => {
        const session = new MachineSession("B-DFS1.2");
        await session.initialise();
        const id = session.addBreakpoint("execute", vectorAt(session, ResetVector));
        expect((await session.runFor(CyclesPerInterlacedFrame)).completed).toBe(false);
        session.resetBreakpointHits();

        session.reset();
        const result = await session.runFor(CyclesPerInterlacedFrame);

        expect(result).toEqual({ completed: false, cyclesRun: 0 });
        expect(session.hitBreakpoint().id).toBe(id);
        session.destroy();
    });
});

describe("MachineSession keyboard", () => {
    let session;
    const HoldCycles = 200000; // a tenth of a second, several OS keyboard scans

    beforeAll(async () => {
        session = await frameAlignedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    async function pressRaw(key) {
        session.keyDownRaw(key);
        await session.runFor(HoldCycles);
        session.keyUpRaw(key);
        await session.runFor(HoldCycles);
    }

    it("types a key pressed by matrix position", async () => {
        await pressRaw(BBC.A);
        await pressRaw(BBC.RETURN);

        expect((await session.runUntilPrompt()).screenText).toContain("A");
    });

    it("reports the keys held, however they were pressed", () => {
        session.keyDownRaw(BBC.A);
        session.keyDown(keyCodes.SHIFT_LEFT);
        expect(session.heldKeys()).toEqual(expect.arrayContaining([BBC.A, BBC.SHIFT]));

        session.keyUpRaw(BBC.A);
        session.keyUp(keyCodes.SHIFT_LEFT);
        expect(session.heldKeys()).toEqual([]);
    });

    it("refuses a key while typing a breakpoint interrupted still owns the keyboard", async () => {
        const id = session.addBreakpoint("execute", 0xffee); // OSWRCH, echoing the first character
        await session.type("X");
        session.removeBreakpoint(id);

        expect(session.typingPending).toBe(true);
        expect(() => session.keyDown(keyCodes.SHIFT_LEFT)).toThrow(/cancelTyping/);
        expect(() => session.keyDownRaw(BBC.SHIFT)).toThrow(/cancelTyping/);

        session.cancelTyping();
        expect(session.typingPending).toBe(false);
        session.keyDown(keyCodes.SHIFT_LEFT);
        expect(session.heldKeys()).toEqual([BBC.SHIFT]);
        session.keyUp(keyCodes.SHIFT_LEFT);

        await pressRaw(BBC.RETURN);
        await session.runUntilPrompt();
    });

    it("refuses a key it does not know, pressed or released", () => {
        for (const press of [(key) => session.keyDown(key), (key) => session.keyUp(key)]) {
            expect(() => press("Shift_Left")).toThrow(/"Shift_Left" is not a key.*keyCodes in keymap\.js/);
            expect(() => press(null)).toThrow(/null is not a key/);
            expect(() => press({})).toThrow(/\{\} is not a key/);
            expect(() => press(16n)).toThrow(/16n is not a key/);
            const circular = {};
            circular.self = circular;
            expect(() => press(circular)).toThrow(/Circular.* is not a key/);
        }
        expect(session.heldKeys()).toEqual([]);
    });

    it("refuses a pre-2.0 numeric key code, naming what replaced it", () => {
        expect(() => session.keyDown(16)).toThrow(/keyDown: 16 is a numeric key code; since 2\.0.*"ShiftLeft"/);
        expect(() => session.keyUp(16)).toThrow(/keyUp: 16 is a numeric key code/);
        expect(session.heldKeys()).toEqual([]);
    });

    it("accepts a key that no BBC key is mapped to", () => {
        session.keyDown(keyCodes.F12);
        expect(session.heldKeys()).toEqual([]);
        session.keyUp(keyCodes.F12);
    });

    it("releases every key held", () => {
        session.keyDownRaw(BBC.SHIFT);
        session.keyDownRaw(BBC.A);

        session.releaseAllKeys();

        expect(session.heldKeys()).toEqual([]);
    });

    it("releasing every key drops pending typing too", async () => {
        const id = session.addBreakpoint("execute", 0xffee);
        await session.type("X");
        session.removeBreakpoint(id);

        session.releaseAllKeys();

        expect(session.typingPending).toBe(false);
        expect(session.heldKeys()).toEqual([]);
        await pressRaw(BBC.RETURN);
        await session.runUntilPrompt();
    });

    it("presses RETURN once for text that already ends in one", async () => {
        const outputOf = async (text) => {
            await session.type(text);
            return (await session.runUntilPrompt()).elements.map((element) => element.text);
        };
        const expected = await outputOf("PRINT 6*7");

        expect(await outputOf("PRINT 6*7\r")).toEqual(expected);
        expect(await outputOf("PRINT 6*7\n")).toEqual(expected);
        expect(await outputOf("PRINT 6*7\r\n")).toEqual(expected);
    });
});

describe("MachineSession keyboard on the Atom", () => {
    let session;

    beforeAll(async () => {
        session = new MachineSession("Atom");
        await session.initialise();
    });

    afterAll(() => session.destroy());

    it("presses a key it knows", () => {
        session.keyDown(keyCodes.A);
        expect(session.heldKeys()).toEqual([ATOM.A]);
        session.keyUp(keyCodes.A);
        expect(session.heldKeys()).toEqual([]);
    });
});

describe("MachineSession paged memory", () => {
    let session;
    const SidewaysRamBank = 4; // one of the Master's four
    const OtherSidewaysRamBank = 5;

    beforeAll(async () => {
        session = await bootedSession("Master");
    }, BootTimeout);

    afterAll(() => session.destroy());

    it("reports what is paged in, agreeing with the OS's copy of ROMSEL", () => {
        const [romselCopy] = session.readMemory(0xf4, 1);

        expect(session.pagingState()).toEqual({
            romsel: romselCopy,
            bank: romselCopy & 15,
            acccon: expect.any(Number),
        });
    });

    it("reads and writes a sideways bank other than the one paged in", () => {
        const before = session.pagingState();

        session.writeMemory(0x8000, [1, 2, 3], { bank: SidewaysRamBank });
        session.writeMemory(0x8000, [9, 9, 9], { bank: OtherSidewaysRamBank });

        expect(session.readMemory(0x8000, 3, { bank: SidewaysRamBank })).toEqual([1, 2, 3]);
        expect(session.readMemory(0x8000, 3, { bank: OtherSidewaysRamBank })).toEqual([9, 9, 9]);
        expect(session.readMemory(0x8000, 3)).toEqual(session.readMemory(0x8000, 3, { bank: before.bank }));
        expect(session.pagingState()).toEqual(before);
    });

    it("reads and writes shadow RAM apart from main RAM", () => {
        const before = session.pagingState();

        session.writeMemory(0x3000, [10, 20], { shadow: true });
        session.writeMemory(0x3000, [30, 40], { shadow: false });

        expect(session.readMemory(0x3000, 2, { shadow: true })).toEqual([10, 20]);
        expect(session.readMemory(0x3000, 2, { shadow: false })).toEqual([30, 40]);
        expect(session.pagingState()).toEqual(before);
    });

    it("refuses a bank that does not exist", () => {
        expect(() => session.readMemory(0x8000, 1, { bank: 16 })).toThrow(/0 to 15/);
    });
});

describe("MachineSession paged memory on a machine without shadow RAM", () => {
    let session;

    beforeAll(async () => {
        session = await frameAlignedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    it("reports ROMSEL and its bank, without ACCCON", () => {
        expect(session.pagingState()).toEqual({ romsel: expect.any(Number), bank: expect.any(Number) });
    });

    it("refuses to page shadow RAM", () => {
        expect(() => session.readMemory(0x3000, 1, { shadow: true })).toThrow(/Master/);
    });

    it("leaves the map alone when it refuses a bank and shadow together", () => {
        const before = session.pagingState();

        expect(() => session.readMemory(0x8000, 1, { bank: 5, shadow: true })).toThrow(/Master/);

        expect(session.pagingState()).toEqual(before);
    });
});

describe("MachineSession frame stepping across a hard reset", () => {
    let session;

    beforeAll(async () => {
        session = await frameAlignedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    it("keeps counting frames where the cycle count starts over", async () => {
        const framesBefore = session.frameCount;
        const cyclesBefore = session.elapsedCycles;

        session.reset(true);
        await session.runFrames(2);

        expect(session.frameCount).toBe(framesBefore + 2);
        expect(session.elapsedCycles).toBeLessThan(cyclesBefore);
    });
});

describe("MachineSession frame stepping with interlace off", () => {
    let session;

    beforeAll(async () => {
        session = await frameAlignedSession();
        await session.runUntilPrompt(30);
        await session.type("*TV 0,1\rMODE 1\r");
        await session.runUntilPrompt(30);
        await session.runFrames();
    }, BootTimeout);

    afterAll(() => session.destroy());

    it("follows the shorter frame the CRTC is now producing", async () => {
        expectCyclesNear(await cyclesOverFrames(session, 5), 5 * CyclesPerNonInterlacedFrame);
    });
});

describe("MachineSession snapshots", () => {
    let session;

    beforeAll(async () => {
        session = await frameAlignedSession();
        await session.runUntilPrompt(30);
    }, BootTimeout);

    afterAll(() => session.destroy());

    async function runAndDrain(command) {
        await session.type(`${command}\r`);
        return (await session.runUntilPrompt(30)).screenText;
    }

    it("rewinds memory the machine has written since", async () => {
        await runAndDrain("A%=42");
        const state = session.snapshot();
        await runAndDrain("A%=99");

        expect(await runAndDrain("PRINT A%")).toContain("99");
        session.restore(state);

        expect(await runAndDrain("PRINT A%")).toContain("42");
    });

    it("rewinds the cycle count", async () => {
        const state = session.snapshot();
        const cyclesAtSnapshot = session.elapsedCycles;
        await session.runFrames(5);
        expect(session.elapsedCycles).toBeGreaterThan(cyclesAtSnapshot);

        session.restore(state);

        expect(session.elapsedCycles).toBe(cyclesAtSnapshot);
    });

    it("keeps counting frames, as a hard reset does", async () => {
        const state = session.snapshot();
        await session.runFrames(3);
        const framesBefore = session.frameCount;

        session.restore(state);
        await session.runFrames(2);

        expect(session.frameCount).toBe(framesBefore + 2);
    });

    it("puts back text captured but not yet drained", async () => {
        await session.type("PRINT 6*7\r");
        await session.runUntilPrompt(30, { clear: false });
        const state = session.snapshot();

        expect(session.drainOutput().screenText).toContain("42");
        expect(session.drainOutput().screenText).not.toContain("42");

        session.restore(state);

        expect(session.drainOutput().screenText).toContain("42");
    });

    it("rewinds the text cursor along with the machine", async () => {
        await runAndDrain("CLS");
        const state = session.snapshot();
        const rowOfHere = (out) => out.elements.find((element) => element.text.includes("HERE")).y;

        await session.type('PRINT "HERE"\r');
        const withoutDetour = rowOfHere(await session.runUntilPrompt(30));

        session.restore(state);
        await runAndDrain("FOR I%=1 TO 5:PRINT:NEXT");
        session.restore(state);
        await session.type('PRINT "HERE"\r');

        expect(rowOfHere(await session.runUntilPrompt(30))).toBe(withoutDetour);
    });

    it("goes on painting after a restore", async () => {
        const state = session.snapshot();
        await runAndDrain("MODE 1");

        session.restore(state);
        await session.runFrames(2);

        expect(await session.screenshot()).toBeInstanceOf(Buffer);
    });

    it(
        "restores into a different session of the same model",
        async () => {
            await runAndDrain("A%=1234");
            const state = session.snapshot();

            const other = new MachineSession("B-DFS1.2");
            await other.initialise();
            other.restore(state);
            await other.type("PRINT A%\r");

            expect((await other.runUntilPrompt(30)).screenText).toContain("1234");
            other.destroy();
        },
        BootTimeout,
    );
});

describe("MachineSession disc images", () => {
    let session;

    beforeAll(async () => {
        session = await bootedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    afterEach(() => vi.restoreAllMocks());

    it("puts a github: disc in a drive from the raw file in the repo", async () => {
        const elite = readFileSync(path.join(RepoRoot, "public/discs/elite.ssd"));
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(elite));
        expect(await session.loadDiscImage("github:someone/games@v1/discs/elite.ssd", 1)).toEqual({
            name: "elite.ssd",
            ignored: [],
        });
        expect(fetch).toHaveBeenCalledWith("https://raw.githubusercontent.com/someone/games/v1/discs/elite.ssd");
        await session.type("*CAT 1");
        expect((await session.runUntilPrompt(30)).screenText).toContain("Elite");
    });

    it("puts a built-in disc in drive 0 by its bare name and catalogues it", async () => {
        expect(await session.loadDiscImage("elite.ssd")).toEqual({ name: "elite.ssd", ignored: [] });
        await session.type("*CAT");
        expect((await session.runUntilPrompt(30)).screenText).toContain("Elite");
    });
});

describe("MachineSession VideoNuLA", () => {
    // Palette mode on, for a VideoNuLA; a stock ULA takes it as a plain control register write.
    const NulaPaletteModeOn = 0x11;
    const Mode7UlaControl = 0x4a;
    const UlaFlashBit = 0x01;

    it.each([
        ["has a stock video ULA unless one is asked for", undefined, 0xff, NulaPaletteModeOn, 0],
        ["fits a VideoNuLA when asked", { hasVideoNula: true }, ~UlaFlashBit, Mode7UlaControl, 1],
    ])(
        "%s",
        async (_, opts, ulaControlMask, ulaControl, paletteMode) => {
            const session = await bootedSession("B-DFS1.2", opts);
            await session.type(`?&FE22=&${NulaPaletteModeOn.toString(16)}`);
            await session.runUntilPrompt();
            const { video } = session.snapshot({ includeRoms: false }).machine;
            session.destroy();

            expect(video.ulactrl & ulaControlMask).toBe(ulaControl);
            expect(video.ula.paletteMode).toBe(paletteMode);
        },
        BootTimeout,
    );
});
