import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MachineSession } from "../../src/machine-session.js";
import { BBC, keyCodes } from "../../src/keymap.js";

const CyclesPerInterlacedFrame = 40000;
const CyclesPerNonInterlacedFrame = 39936;
const BootTimeout = 60000;

// A run stops at the instruction boundary after the paint, so cyclesRun lands
// either side of the frame length by up to one instruction: seven cycles, plus
// the stretching an RMW on the 1MHz bus picks up. Still far inside the 64
// cycles between an interlaced frame and a non-interlaced one.
const MaxOvershootCycles = 16;

function expectCyclesNear(actual, expected) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(MaxOvershootCycles);
}

async function bootedSession() {
    const session = new MachineSession("B-DFS1.2");
    await session.initialise();
    await session.boot(30);
    await session.runFrames();
    return session;
}

async function cyclesOverFrames(session, frames) {
    const before = session.elapsedCycles;
    for (let i = 0; i < frames; i++) await session.runFrames();
    return session.elapsedCycles - before;
}

describe("MachineSession frame stepping", () => {
    let session;

    beforeAll(async () => {
        session = await bootedSession();
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
        const [lo, hi] = session.readMemory(0x204, 2); // IRQ1V, entered every interrupt
        const id = session.addBreakpoint("execute", lo | (hi << 8));

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
        session = await bootedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    function breakOnNextInterrupt() {
        const [lo, hi] = session.readMemory(0x204, 2); // IRQ1V, entered every interrupt
        return session.addBreakpoint("execute", lo | (hi << 8));
    }

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

describe("MachineSession keyboard", () => {
    let session;
    const HoldCycles = 200000; // a tenth of a second, several OS keyboard scans

    beforeAll(async () => {
        session = await bootedSession();
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
});

describe("MachineSession paged memory", () => {
    let session;
    const SidewaysRamBank = 4; // one of the Master's four
    const OtherSidewaysRamBank = 5;

    beforeAll(async () => {
        session = new MachineSession("Master");
        await session.initialise();
        await session.boot(30);
    }, BootTimeout);

    afterAll(() => session.destroy());

    it("reports what is paged in, agreeing with the OS's copy of ROMSEL", () => {
        const [romselCopy] = session.readMemory(0xf4, 1);

        expect(session.pagingState()).toEqual({ romsel: romselCopy, acccon: expect.any(Number) });
    });

    it("reads and writes a sideways bank other than the one paged in", () => {
        const before = session.pagingState();

        session.writeMemory(0x8000, [1, 2, 3], { bank: SidewaysRamBank });
        session.writeMemory(0x8000, [9, 9, 9], { bank: OtherSidewaysRamBank });

        expect(session.readMemory(0x8000, 3, { bank: SidewaysRamBank })).toEqual([1, 2, 3]);
        expect(session.readMemory(0x8000, 3, { bank: OtherSidewaysRamBank })).toEqual([9, 9, 9]);
        expect(session.readMemory(0x8000, 3)).toEqual(session.readMemory(0x8000, 3, { bank: before.romsel & 15 }));
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
        session = await bootedSession();
    }, BootTimeout);

    afterAll(() => session.destroy());

    it("reports ROMSEL alone", () => {
        expect(session.pagingState()).toEqual({ romsel: expect.any(Number) });
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
        session = await bootedSession();
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
        session = await bootedSession();
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
        session = await bootedSession();
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
    it(
        "puts a built-in disc in drive 0 by its bare name and catalogues it",
        async () => {
            const session = new MachineSession("B-DFS1.2");
            await session.initialise();
            await session.boot(30);
            expect(await session.loadDiscImage("elite.ssd")).toEqual({ name: "elite.ssd", ignored: [] });
            await session.type("*CAT");
            const { screenText } = await session.runUntilPrompt(30);
            expect(screenText).toContain("Elite");
            session.destroy();
        },
        BootTimeout,
    );
});
