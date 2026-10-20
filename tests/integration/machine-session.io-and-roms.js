import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MachineSession } from "../../src/machine-session.js";
import { BBC } from "../../src/keymap.js";
import { RepoRoot } from "./helpers.js";
import { BootTimeout, CyclesPerSecond, bootedSession } from "./machine-session-shared.js";

describe("MachineSession tapes", () => {
    afterEach(() => vi.restoreAllMocks());
    const Welcome = path.join(RepoRoot, "public/tapes/Welcome.uef");
    const LoadCycles = 10 * CyclesPerSecond;

    const tapeDeck = (session) => session._machine.processor.tapeInterface;

    it(
        "plays a tape from bytes already read",
        async () => {
            const session = await bootedSession();
            await session.loadTape("welcome.uef", new Uint8Array(readFileSync(Welcome)));
            await session.type("*TAPE");
            await session.type('CHAIN""');
            await session.runFor(LoadCycles);
            expect(session.drainOutput().screenText).toMatch(/Loading\s+INTRO/);
            session.destroy();
        },
        BootTimeout,
    );

    it("reads a tape from its file when given no bytes", async () => {
        const fromFile = new MachineSession("B-DFS1.2");
        const fromBytes = new MachineSession("B-DFS1.2");
        await fromFile.loadTape(Welcome);
        await fromBytes.loadTape(Welcome, new Uint8Array(readFileSync(Welcome)));
        expect(tapeDeck(fromFile).tape).toEqual(tapeDeck(fromBytes).tape);
    });

    it(
        "runs an Atom's tape as soon as it is in, since its recorder has no relay",
        async () => {
            const session = new MachineSession("Atom-Tape");
            await session.initialise();
            await session.loadTape(Welcome);
            expect(tapeDeck(session).tapeRunning).toBe(true);
            session.destroy();
        },
        BootTimeout,
    );

    it("resolves an sth: tape from the archive's tape images", async () => {
        const zip = readFileSync(path.join(RepoRoot, "tests/unit/zip/test-ssd.zip"));
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(zip));
        vi.spyOn(console, "log").mockImplementation(() => {});
        const session = new MachineSession("B-DFS1.2");
        expect((await session.mediaResolver().resolve("tape", "sth:Acornsoft/Elite.zip")).name).toBe("test.ssd");
        expect(fetch).toHaveBeenCalledWith("https://bbc.xania.org/archive/sth/tapeimages/Acornsoft/Elite.zip");
    });
});

describe("MachineSession keyboard buffer", () => {
    const AutorepeatFrames = 100;
    const PastTheWait = 3 * CyclesPerSecond;
    const ReportAfterWait =
        'T%=TIME:REPEAT UNTIL TIME>T%+300:A$="":REPEAT K$=INKEY$(0):A$=A$+K$:UNTIL K$="":PRINT "<";A$;">"';

    async function keysLeftAfterHolding(session, flush) {
        await session.type(ReportAfterWait);
        session.keyDownRaw(BBC.K1);
        await session.runFrames(AutorepeatFrames);
        session.keyUpRaw(BBC.K1);
        if (flush) session.flushKeyboardBuffer();
        await session.runFor(PastTheWait);
        const { screenText } = session.drainOutput();
        return screenText.match(/<(\w*)>/)[1];
    }

    it.each(["B-DFS1.2", "Master"])(
        "%s: a held key's autorepeats wait in the buffer until it is flushed",
        async (model) => {
            const session = await bootedSession(model);
            expect(await keysLeftAfterHolding(session, false)).toMatch(/^11+$/);
            expect(await keysLeftAfterHolding(session, true)).toBe("");
            session.destroy();
        },
        BootTimeout,
    );

    it("refuses on the Atom, whose OS has no keyboard buffer", () => {
        const session = new MachineSession("Atom");
        expect(() => session.flushKeyboardBuffer()).toThrow(/Atom/);
    });
});

describe("MachineSession Econet", () => {
    async function typeAll(session, lines) {
        for (const line of lines) await session.type(line);
        return (await session.runUntilPrompt(30)).screenText;
    }

    it(
        "logs a Master on to the file server through ANFS",
        async () => {
            const session = await bootedSession("Master", { econet: true });
            expect(await typeAll(session, ["*NET", "*I AM SYST", "*CAT"])).toMatch(/Dir\. \$ .*Lib\. LIBRARY/);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "answers to the web page's station number unless given one",
        async () => {
            const session = await bootedSession("B-DFS1.2", { econet: true });
            expect(await typeAll(session, ["PRINT ?&FE18"])).toMatch(/^\s+101$/m);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "keeps the station number it is given in a Master's CMOS",
        async () => {
            const session = await bootedSession("Master", { econet: true, stationId: 42 });
            const readCmosStation = ["A%=161", "X%=0", "PRINT (USR&FFF4 AND &FF0000) DIV &10000"];
            expect(await typeAll(session, readCmosStation)).toMatch(/^\s+42$/m);
            session.destroy();
        },
        BootTimeout,
    );

    it("refuses a station number it cannot be, or one without Econet", () => {
        for (const stationId of [1, 253]) {
            expect(() => new MachineSession("B-DFS1.2", { econet: true, stationId })).not.toThrow();
        }
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
    const HigherSpareBank = 5;
    const RomTitle = 0x8009;
    // The MOS ignores a ROM identical to one in a higher bank.
    const UnduplicatedTitle = 0x55;
    const ServiceWrite = 0x70;
    const RunSecs = 5;
    const RomselBankMask = 0x0f;
    // A service ROM titled "T" whose service handler stores A at ServiceWrite and returns.
    const ServiceRom = [
        0,
        0,
        0,
        0x4c,
        0x0e,
        0x80,
        0x82,
        0x0a,
        0x01,
        0x54,
        0x00,
        0x28,
        0x43,
        0x29,
        0x85,
        ServiceWrite,
        0x60,
    ];

    async function sessionWithSpareRom() {
        const session = new MachineSession("B-DFS1.2");
        await session.initialise();
        session.writeMemory(0x8000, ServiceRom, { bank: SpareBank });
        session.writeMemory(0x8000, ServiceRom, { bank: HigherSpareBank });
        session.writeMemory(RomTitle, [UnduplicatedTitle], { bank: HigherSpareBank });
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

    it("breaks on a write only while the bank it is given is paged in", async () => {
        const session = await sessionWithSpareRom();
        const id = session.addBreakpoint("write", ServiceWrite, { bank: SpareBank });

        await session.runFor(RunSecs * CyclesPerSecond);

        expect(session.hitBreakpoint()).toMatchObject({ id, type: "write", address: ServiceWrite, bank: SpareBank });
        expect(pagedBank(session)).toBe(SpareBank);
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
        const session = new MachineSession("B-DFS1.2");

        expect(() => session.addBreakpoint("execute", ServiceEntry, { bank: 16 })).toThrow("Bank 16 is not 0 to 15");
        await expect(session.runUntilAddress(ServiceEntry, RunSecs, { bank: -1 })).rejects.toThrow(
            "Bank -1 is not 0 to 15",
        );
        session.destroy();
    });
});

describe("MachineSession bank breakpoints on a Master with ANDY paged in", () => {
    const SidewaysRamBank = 4;
    const RomselWithAndy = 0x80 | SidewaysRamBank;
    const CodeAddress = 0x2000;
    const AndyLoop = 0x8000;
    const BankLoop = 0x9000;
    const RunSecs = 1;
    const lo = (address) => address & 0xff;
    const hi = (address) => address >> 8;

    // Pages in ANDY over SidewaysRamBank, writes a JMP-to-self into ANDY, then jumps to `target`.
    const pageAndyAndJumpTo = (target) => [
        0x78,
        0xa9,
        RomselWithAndy,
        0x8d,
        0x30,
        0xfe,
        ...[0x4c, lo(AndyLoop), hi(AndyLoop)].flatMap((byte, i) => [0xa9, byte, 0x8d, lo(AndyLoop + i), hi(AndyLoop)]),
        0x4c,
        lo(target),
        hi(target),
    ];

    async function sessionLooping(target) {
        const session = await bootedSession("Master");
        session.writeMemory(BankLoop, [0x4c, lo(BankLoop), hi(BankLoop)], { bank: SidewaysRamBank });
        session.writeMemory(CodeAddress, pageAndyAndJumpTo(target));
        await session.type(`CALL &${CodeAddress.toString(16)}`);
        return session;
    }

    it(
        "does not count ANDY at &8000 to &8FFF as the bank",
        async () => {
            const session = await sessionLooping(AndyLoop);

            await expect(session.runUntilAddress(AndyLoop, RunSecs, { bank: SidewaysRamBank })).rejects.toThrow(
                "did not hit appropriate breakpoint in time",
            );
            expect(session.pagingState().romsel).toBe(RomselWithAndy);
            expect(session.registers().pc).toBe(AndyLoop);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "still counts &9000 to &BFFF as the bank",
        async () => {
            const session = await sessionLooping(BankLoop);

            await session.runUntilAddress(BankLoop, RunSecs, { bank: SidewaysRamBank });

            expect(session.registers().pc).toBe(BankLoop);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "does not break in ANDY on a breakpoint given the bank",
        async () => {
            const session = await sessionLooping(AndyLoop);
            session.addBreakpoint("execute", AndyLoop, { bank: SidewaysRamBank });

            const { completed } = await session.runFor(RunSecs * CyclesPerSecond);

            expect(completed).toBe(true);
            expect(session.hitBreakpoint()).toBeNull();
            expect(session.registers().pc).toBe(AndyLoop);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "does not break on a read in ANDY given the bank",
        async () => {
            const session = await sessionLooping(AndyLoop);
            session.addBreakpoint("read", AndyLoop + 1, { bank: SidewaysRamBank });

            const { completed } = await session.runFor(RunSecs * CyclesPerSecond);

            expect(completed).toBe(true);
            expect(session.hitBreakpoint()).toBeNull();
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "breaks above ANDY on a breakpoint given the bank",
        async () => {
            const session = await sessionLooping(BankLoop);
            const id = session.addBreakpoint("execute", BankLoop, { bank: SidewaysRamBank });

            const { completed } = await session.runFor(RunSecs * CyclesPerSecond);

            expect(completed).toBe(false);
            expect(session.hitBreakpoint()).toEqual({ id, type: "execute", address: BankLoop, bank: SidewaysRamBank });
            session.destroy();
        },
        BootTimeout,
    );
});
