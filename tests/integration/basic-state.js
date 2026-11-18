import { describe, expect, it } from "vitest";

import {
    basicRom,
    LanguageRomNumber,
    lineHolding,
    readPointers,
    readReportedError,
    readWait,
} from "../../src/basic-state.js";
import { bootedTestMachine } from "./helpers.js";

const Frame = 40000;
const SamplesTaken = 12;
const Keyboard = (keyword) => ({ kind: "keyboard", keyword });
const FilingSystem = { kind: "filing system", keyword: null };

const kinds = (waits) => new Set(waits.map((wait) => JSON.stringify(wait)));

// Runs `program` on `model`, and gives a way to sample readWait once a frame, with frames of different lengths so
// that the samples fall at different points of what the program does.
async function runningOn(model, program) {
    const machine = await bootedTestMachine(model);
    const cpu = machine.processor;
    const peek = (address) => cpu.peekmemAsLanguage(address);
    const { keywords } = basicRom(cpu.romBank(cpu.bankPagedBy(peek(LanguageRomNumber))));
    await machine.loadBasic(program);
    await machine.type("RUN");
    await machine.runFor(Frame);
    const read = () => {
        const { page, reading } = readPointers(peek);
        return readWait(cpu, lineHolding(peek, page, reading), keywords);
    };
    // Frames of different lengths, so that the samples fall at different points of what the program does.
    const samples = async () => {
        const found = [];
        for (let sample = 0; sample < SamplesTaken; ++sample) {
            await machine.runFor(Frame + 997 * sample);
            found.push(read());
        }
        return found;
    };
    return { machine, samples, read };
}

const DivisionByZero = { number: 18, message: "Division by zero", lineNumber: 10 };

describe.each(["B-DFS1.2", "Master"])("readReportedError on a %s", (model) => {
    it.each([
        ["10 PRINT 1/0", ["RUN"], DivisionByZero],
        ["10 X=(1", ["RUN"], { number: 27, message: "Missing )", lineNumber: 10 }],
        ["10 PROCnone", ["RUN"], { number: 29, message: "No such FN/PROC", lineNumber: 10 }],
        ['10 ON ERROR PRINT "caught":END\n20 STOP', ["RUN"], { number: 0, message: "STOP", lineNumber: 20 }],
        ['10 ON ERROR PRINT "caught":END\n20 X=1/0', ["RUN"], null],
        ["10 PRINT 1/0", ["RUN", "LIST"], DivisionByZero],
        ["10 PRINT 1/0", ["RUN", "PRINT ERL"], null],
        ["", ["PRINT 1/0"], { ...DivisionByZero, lineNumber: 0 }],
        ["", [], null],
    ])("reads %j after %j as %j", async (program, commands, expected) => {
        const machine = await bootedTestMachine(model);
        const cpu = machine.processor;
        const peek = (address) => cpu.peekmemAsLanguage(address);
        const { keywords } = basicRom(cpu.romBank(cpu.bankPagedBy(peek(LanguageRomNumber))));
        if (program) await machine.loadBasic(program);
        for (const command of commands) {
            await machine.type(command);
            await machine.runUntilInput();
        }
        expect(readReportedError(peek, keywords)).toEqual(expected);
    });
});

describe.each(["B-DFS1.2", "Master"])("readWait on a %s", (model) => {
    const running = (program) => runningOn(model, program);

    it.each([
        ["10 X=1:A$=GET$", Keyboard("GET$")],
        ["10 A$=INKEY$(500)", Keyboard("INKEY$")],
        ['10 INPUT LINE "Name: " A$', Keyboard("INPUT LINE")],
        ['10 A$="":IF A$="" THEN INPUT A$', Keyboard("INPUT")],
        ['10 A$="":IF A$<>"" THEN X=1 ELSE INPUT LINE A$', Keyboard("INPUT LINE")],
        ["10 REPEAT INPUT A$ UNTIL FALSE", Keyboard("INPUT")],
        ["10 X=GET:INPUT A$", Keyboard("GET")],
        ["10 CALL &FFE0", Keyboard(null)],
        ["10 IF TRUE THEN SOUND 1,-15,100,200:GOTO 10", { kind: "sound", keyword: null }],
        // Machine code that leaves the filing system's ROM paged in while it runs in RAM.
        ["10 DIM C% 20:P%=C%\n20 [OPT 0:LDA &DBC:STA &F4:STA &FE30:.l JMP l:]\n30 CALL C%", null],
    ])("reads %j as waiting in %j wherever it is sampled", async (program, expected) => {
        const { samples } = await running(program);
        expect(kinds(await samples())).toEqual(kinds([expected]));
    });

    it("reads BASIC's prompt as reading the keyboard, with no keyword as there is no line", async () => {
        const machine = await bootedTestMachine(model);
        const cpu = machine.processor;
        const { keywords } = basicRom(cpu.romBank(cpu.bankPagedBy(cpu.peekmemAsLanguage(LanguageRomNumber))));
        expect(readWait(cpu, null, keywords)).toEqual(Keyboard(null));
    });

    // These pass through a place a program can wait without waiting, and a sample can land there; only how long the
    // program stays tells them from a wait.
    it.each([
        ["10 REPEAT:A=INKEY(0):UNTIL FALSE", [null, Keyboard("INKEY")]],
        // Offers every ROM in turn a service call that none of them takes.
        ["10 REPEAT:*FX143,96\n20 UNTIL FALSE", [null, FilingSystem]],
        [
            "10 REPEAT:SOUND 1,0,0,1:T%=TIME:REPEAT UNTIL TIME>T%+10:UNTIL FALSE",
            [null, { kind: "sound", keyword: null }],
        ],
    ])("reads %j only as at no wait, or passing through %j", async (program, expected) => {
        const { samples } = await running(program);
        const found = await samples();
        expect([...kinds(found)].every((wait) => kinds(expected).has(wait))).toBe(true);
        expect(found.filter((wait) => wait === null).length).toBeGreaterThan(SamplesTaken / 2);
    });

    it("moves from GET to GET$ in one statement as a key is pressed", async () => {
        const { machine, samples } = await running("10 PRINT GET;GET$");
        expect((await samples()).at(-1)).toEqual(Keyboard("GET"));
        machine.keyDown("KeyA");
        await machine.runFor(5 * Frame);
        machine.keyUp("KeyA");
        expect((await samples()).at(-1)).toEqual(Keyboard("GET$"));
    });
});

// Every BBC model jsbeeb has a BASIC on: the OS 1.20 machines, whatever their filing system, the US OS, MOS 0.10 and
// the Master's MOS 3.20 with each filing system.
const BbcModels = [
    "B-DFS1.2",
    "B-DFS0.9",
    "B1770",
    "B1770A",
    "B-stock",
    "B-US",
    "B-German",
    "B-MOS0.10",
    "Master",
    "MasterADFS",
    "MasterANFS",
];
// Those whose filing system waits for ever for an empty drive; ADFS and ANFS report an error at once.
const DfsModels = new Set(["B-DFS1.2", "B-DFS0.9", "B1770", "B-stock", "B-US", "B-German", "Master"]);

describe.each(BbcModels)("readWait on every model: %s", (model) => {
    it.each([
        ["10 G=GET", Keyboard("GET")],
        ["10 A$=GET$", Keyboard("GET$")],
        ["10 A=INKEY(500)", Keyboard("INKEY")],
        ["10 INPUT X", Keyboard("INPUT")],
        ["10 INPUT LINE A$", Keyboard("INPUT LINE")],
        ["10 REPEAT:SOUND 1,-15,100,200:UNTIL FALSE", { kind: "sound", keyword: null }],
        ["10 REPEAT:X=X+1:UNTIL FALSE", null],
    ])("reads %j as %j", async (program, expected) => {
        const { samples } = await runningOn(model, program);
        expect(kinds(await samples())).toEqual(kinds([expected]));
    });

    // MOS 0.10 has no OSBYTE 19: *FX19 is "Bad command" there. The samples that are not in the wait fall in the
    // interrupt that ends it, or on the Master in *FX19's own pass through the ROMs.
    it.skipIf(model === "B-MOS0.10")("reads *FX19 as waiting for vsync in most samples", async () => {
        const { samples } = await runningOn(model, "10 REPEAT:*FX19\n20 UNTIL FALSE");
        const found = await samples();
        expect(found.filter((wait) => wait?.kind === "vsync").length).toBeGreaterThan(SamplesTaken / 2);
        expect(found.filter((wait) => wait?.kind === "keyboard" || wait?.kind === "sound")).toEqual([]);
    });

    it.runIf(DfsModels.has(model))("reads CHAIN with no disc as in the filing system", async () => {
        const { samples } = await runningOn(model, '10 CHAIN "X"');
        const found = await samples();
        expect([...kinds(found)].every((wait) => kinds([null, FilingSystem]).has(wait))).toBe(true);
        expect(found.filter((wait) => wait?.kind === "filing system").length).toBeGreaterThan((SamplesTaken * 3) / 4);
    });

    // Its only filing system is the tape's, in the OS, which readWait does not place.
    it.runIf(model === "B-MOS0.10")("reads CHAIN searching the tape as at no wait", async () => {
        const { samples } = await runningOn(model, '10 CHAIN "X"');
        expect(kinds(await samples())).toEqual(kinds([null]));
    });
});
