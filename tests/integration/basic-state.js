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
    async function running(program) {
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
        return { machine, samples };
    }

    it.each([
        ["10 G=GET", Keyboard("GET")],
        ["10 X=1:A$=GET$", Keyboard("GET$")],
        ["10 A=INKEY(500)", Keyboard("INKEY")],
        ["10 A$=INKEY$(500)", Keyboard("INKEY$")],
        ["10 INPUT X", Keyboard("INPUT")],
        ['10 INPUT LINE "Name: " A$', Keyboard("INPUT LINE")],
        ["10 CALL &FFE0", Keyboard(null)],
        ['10 CHAIN "X"', { kind: "filing system", keyword: null }],
        ["10 REPEAT:SOUND 1,-15,100,200:UNTIL FALSE", { kind: "sound", keyword: null }],
    ])("reads %j as waiting in %j wherever it is sampled", async (program, expected) => {
        const { samples } = await running(program);
        expect(new Set((await samples()).map((wait) => JSON.stringify(wait)))).toEqual(
            new Set([JSON.stringify(expected)]),
        );
    });

    it("reads *FX19 as waiting for vsync when sampled in its loop, as most samples are", async () => {
        const { samples } = await running("10 REPEAT:*FX19\n20 UNTIL FALSE");
        const vsync = (await samples()).filter((wait) => wait?.kind === "vsync");
        expect(vsync.length).toBeGreaterThan(SamplesTaken / 2);
    });

    it.each(["10 REPEAT:X=X+1:UNTIL FALSE", "10 REPEAT:A=INKEY(0):UNTIL FALSE"])(
        "reads %j mostly as not at a wait",
        async (program) => {
            const { samples } = await running(program);
            const waits = (await samples()).filter((wait) => wait !== null);
            expect(waits.length).toBeLessThan(SamplesTaken / 4);
        },
    );

    it("moves from GET to GET$ in one statement as a key is pressed", async () => {
        const { machine, samples } = await running("10 PRINT GET;GET$");
        expect((await samples()).at(-1)).toEqual(Keyboard("GET"));
        machine.keyDown("KeyA");
        await machine.runFor(5 * Frame);
        machine.keyUp("KeyA");
        expect((await samples()).at(-1)).toEqual(Keyboard("GET$"));
    });
});
