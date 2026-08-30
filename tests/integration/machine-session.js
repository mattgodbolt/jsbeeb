import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MachineSession } from "../../src/machine-session.js";

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
