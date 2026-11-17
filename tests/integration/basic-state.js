import { describe, expect, it } from "vitest";

import { basicRom, LanguageRomNumber, readReportedError } from "../../src/basic-state.js";
import { bootedTestMachine } from "./helpers.js";

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
