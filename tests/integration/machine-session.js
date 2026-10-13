import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MachineSession } from "../../src/machine-session.js";
import { BBC, keyCodes } from "../../src/keymap.js";
import { ATOM } from "../../src/keymap-atom.js";
import { RepoRoot } from "./helpers.js";

const CyclesPerInterlacedFrame = 40000;
const CyclesPerNonInterlacedFrame = 39936;
const CyclesPerSecond = 2000000;
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

describe("MachineSession keyboard buffer", () => {
    const AutorepeatFrames = 100;
    const PastTheWait = 3 * CyclesPerSecond;
    const ReportAfterWait =
        'T%=TIME:REPEAT UNTIL TIME>T%+300:A$="":REPEAT K$=INKEY$(0):A$=A$+K$:UNTIL K$="":PRINT "<";A$;">"';

    async function keysLeftAfterHolding(model, flush) {
        const session = new MachineSession(model);
        await session.initialise();
        await session.boot(30);
        await session.type(ReportAfterWait);
        session.keyDownRaw(BBC.K1);
        await session.runFrames(AutorepeatFrames);
        session.keyUpRaw(BBC.K1);
        if (flush) session.flushKeyboardBuffer();
        await session.runFor(PastTheWait);
        const { screenText } = session.drainOutput();
        session.destroy();
        return screenText.match(/<(\w*)>/)[1];
    }

    it.each(["B-DFS1.2", "Master"])(
        "%s: a held key's autorepeats wait in the buffer until it is flushed",
        async (model) => {
            expect(await keysLeftAfterHolding(model, false)).toMatch(/^11+$/);
            expect(await keysLeftAfterHolding(model, true)).toBe("");
        },
        BootTimeout,
    );

    it("refuses on the Atom, whose OS has no keyboard buffer", () => {
        const session = new MachineSession("Atom");
        expect(() => session.flushKeyboardBuffer()).toThrow(/Atom/);
    });
});

describe("MachineSession keyboard on the Atom", () => {
    let session;

    beforeAll(async () => {
        session = new MachineSession("Atom");
        await session.initialise();
    });

    afterAll(() => session.destroy());

    it("refuses a key it does not know, as the BBC does", () => {
        expect(() => session.keyDown("Shift_Left")).toThrow(/"Shift_Left" is not a key/);
        expect(() => session.keyUp(16)).toThrow(/keyUp: 16 is a numeric key code/);
    });

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

describe("MachineSession tapes", () => {
    const Welcome = path.join(RepoRoot, "public/tapes/Welcome.uef");
    const LoadCycles = 10 * CyclesPerSecond;

    async function firstProgramLoading(load) {
        const session = new MachineSession("B-DFS1.2");
        await session.initialise();
        await session.boot(30);
        await load(session);
        await session.type("*TAPE");
        await session.type('CHAIN""');
        await session.runFor(LoadCycles);
        const { screenText } = session.drainOutput();
        session.destroy();
        return screenText;
    }

    it(
        "plays a tape from a file",
        async () => {
            expect(await firstProgramLoading((session) => session.loadTape(Welcome))).toMatch(/Loading\s+INTRO/);
        },
        BootTimeout,
    );

    it(
        "plays a tape from bytes already read",
        async () => {
            const data = new Uint8Array(readFileSync(Welcome));
            expect(await firstProgramLoading((session) => session.loadTape("welcome.uef", data))).toMatch(
                /Loading\s+INTRO/,
            );
        },
        BootTimeout,
    );

    it(
        "runs an Atom's tape as soon as it is in, since its recorder has no relay",
        async () => {
            const session = new MachineSession("Atom-Tape");
            await session.initialise();
            await session.loadTape(Welcome);
            expect(session._machine.processor.tapeInterface.tapeRunning).toBe(true);
            session.destroy();
        },
        BootTimeout,
    );
});

describe("MachineSession disc images", () => {
    afterEach(() => vi.restoreAllMocks());

    it(
        "puts a github: disc in a drive from the raw file in the repo",
        async () => {
            const session = new MachineSession("B-DFS1.2");
            await session.initialise();
            await session.boot(30);
            const elite = readFileSync(path.join(RepoRoot, "public/discs/elite.ssd"));
            const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(elite));
            expect(await session.loadDiscImage("github:someone/games@v1/discs/elite.ssd", 1)).toEqual({
                name: "elite.ssd",
                ignored: [],
            });
            expect(fetch).toHaveBeenCalledWith("https://raw.githubusercontent.com/someone/games/v1/discs/elite.ssd");
            await session.type("*CAT 1");
            const { screenText } = await session.runUntilPrompt(30);
            expect(screenText).toContain("Elite");
            session.destroy();
        },
        BootTimeout,
    );

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

describe("MachineSession Econet", () => {
    async function typeAll(session, lines) {
        for (const line of lines) await session.type(line);
        return (await session.runUntilPrompt(30)).screenText;
    }

    it(
        "logs a Master on to the file server through ANFS",
        async () => {
            const session = new MachineSession("Master", { econet: true });
            await session.initialise();
            await session.boot(30);
            expect(await typeAll(session, ["*NET", "*I AM SYST", "*CAT"])).toContain("WELCOME");
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "answers to the station number it is given",
        async () => {
            const session = new MachineSession("B-DFS1.2", { econet: true, stationId: 42 });
            await session.initialise();
            await session.boot(30);
            expect(await typeAll(session, ["PRINT ?&FE18"])).toMatch(/^\s+42$/m);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "keeps the station number it is given in a Master's CMOS",
        async () => {
            const session = new MachineSession("Master", { econet: true, stationId: 42 });
            await session.initialise();
            await session.boot(30);
            const readCmosStation = ["A%=161", "X%=0", "PRINT (USR&FFF4 AND &FF0000) DIV &10000"];
            expect(await typeAll(session, readCmosStation)).toMatch(/^\s+42$/m);
            session.destroy();
        },
        BootTimeout,
    );

    it("refuses a station number it cannot be, or one without Econet", () => {
        for (const stationId of [0, 254, 255, 1.5, "42"]) {
            expect(() => new MachineSession("B-DFS1.2", { econet: true, stationId })).toThrow(/is not 1 to 253/);
        }
        expect(() => new MachineSession("B-DFS1.2", { stationId: 42 })).toThrow("A station number needs Econet fitted");
    });
});

describe("MachineSession breakpoints in sideways ROM", () => {
    const ServiceEntry = 0x8003;
    const RomTypeByte = 0x8006;
    const DfsBank = 14;
    const SpareBank = 4;
    const RunSecs = 5;
    const RomselBankMask = 0x0f;
    // A service ROM titled "T" whose service handler only returns.
    const ServiceRom = [0, 0, 0, 0x4c, 0x0e, 0x80, 0x82, 0x0a, 0x01, 0x54, 0x00, 0x28, 0x43, 0x29, 0x60];

    async function sessionWithSpareRom() {
        const session = new MachineSession("B-DFS1.2");
        await session.initialise();
        session.writeMemory(0x8000, ServiceRom, { bank: SpareBank });
        return session;
    }

    const pagedBank = (session) => session.pagingState().romsel & RomselBankMask;

    it("breaks in whichever bank is paged in when given none", async () => {
        const session = await sessionWithSpareRom();
        session.addBreakpoint("execute", ServiceEntry);

        await session.runFor(RunSecs * CyclesPerSecond);

        expect(pagedBank(session)).toBe(DfsBank);
        session.destroy();
    });

    it("breaks only while the bank it is given is paged in", async () => {
        const session = await sessionWithSpareRom();
        const id = session.addBreakpoint("execute", ServiceEntry, { bank: SpareBank });

        const { completed } = await session.runFor(RunSecs * CyclesPerSecond);

        expect(completed).toBe(false);
        expect(session.hitBreakpoint()).toEqual({ id, type: "execute", address: ServiceEntry, bank: SpareBank });
        expect(session.registers().pc).toBe(ServiceEntry);
        expect(pagedBank(session)).toBe(SpareBank);
        session.destroy();
    });

    it("breaks on a read only while the bank it is given is paged in", async () => {
        const session = await sessionWithSpareRom();
        const [dfsType] = session.readMemory(RomTypeByte, 1, { bank: DfsBank });
        const id = session.addBreakpoint("read", RomTypeByte, { bank: DfsBank });

        await session.runFor(RunSecs * CyclesPerSecond);

        expect(session.hitBreakpoint()).toEqual({
            id,
            type: "read",
            address: RomTypeByte,
            bank: DfsBank,
            value: dfsType,
        });
        expect(pagedBank(session)).toBe(DfsBank);
        session.destroy();
    });

    it("runs until an address in the bank it is given", async () => {
        const session = await sessionWithSpareRom();

        await session.runUntilAddress(ServiceEntry, RunSecs, { bank: SpareBank });

        expect(session.registers().pc).toBe(ServiceEntry);
        expect(pagedBank(session)).toBe(SpareBank);
        session.destroy();
    });

    it("refuses a bank that does not exist", async () => {
        const session = await sessionWithSpareRom();

        expect(() => session.addBreakpoint("execute", ServiceEntry, { bank: 16 })).toThrow("Bank 16 is not 0 to 15");
        await expect(session.runUntilAddress(ServiceEntry, RunSecs, { bank: -1 })).rejects.toThrow(
            "Bank -1 is not 0 to 15",
        );
        session.destroy();
    });
});
