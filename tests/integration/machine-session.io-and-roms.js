import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MachineSession } from "../../src/machine-session.js";
import { BBC } from "../../src/keymap.js";
import { RepoRoot } from "./helpers.js";
import { BootTimeout, CyclesPerSecond, bootedSession } from "../helpers/machine-session.js";

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
        expect(tapeDeck(fromBytes).tape).toBeDefined();
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

describe("MachineSession sideways ROMs", () => {
    const RomTitle = 0x8009;
    const titleIn = (session, bank) => String.fromCharCode(...session.readMemory(RomTitle, 3, { bank }));

    it(
        "loads a bank ROM into its bank and an extra ROM into the highest free one, and *HELP lists both",
        async () => {
            const session = await bootedSession("B-DFS1.2", {
                bankRoms: [{ bank: 7, rom: "ample.rom" }],
                extraRoms: ["ats-3.0.rom"],
            });
            expect([titleIn(session, 7), titleIn(session, 13)]).toEqual(["AMP", "ATS"]);
            await session.type("*HELP");
            await session.runFor(CyclesPerSecond);
            const { screenText } = session.drainOutput();
            expect(screenText).toContain("AMPLE Nucleus");
            expect(screenText).toContain("ATS 3.0");
            session.destroy();
        },
        BootTimeout,
    );

    it("refuses a bank the model fills already, as the page does", async () => {
        const session = new MachineSession("B-DFS1.2", { bankRoms: [{ bank: 15, rom: "ample.rom" }] });
        await expect(session.initialise()).rejects.toThrow(
            "Can't load ample.rom into ROM bank 15, which already holds BASIC.ROM",
        );
    });
});

describe("MachineSession breakpoints in sideways ROM", () => {
    const ServiceEntry = 0x8003;
    const SpareBank = 4;
    const HigherSpareBank = 5;
    const RomTitle = 0x8009;
    // The MOS ignores a ROM identical to one in a higher bank.
    const UnduplicatedTitle = 0x55;
    const ServiceWrite = 0x70;
    const RunSecs = 5;
    const RomselBankMask = 0x0f;
    // A service ROM titled "T" whose service handler stores A at ServiceWrite and returns.
    // prettier-ignore
    const ServiceRom = [
        0, 0, 0, // no language entry
        0x4c, 0x0e, 0x80, // JMP &800E
        0x82, // ROM type: service, 6502
        0x0a, // copyright offset
        0x01, // version
        0x54, 0x00, // "T"
        0x28, 0x43, 0x29, // "(C)"
        0x85, ServiceWrite, // STA ServiceWrite
        0x60, // RTS
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
