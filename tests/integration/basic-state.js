import { describe, expect, it } from "vitest";

import { basicRom, LanguageRomNumber, readReportedError } from "../../src/basic-state.js";
import { bootedTestMachine } from "./helpers.js";

describe.each(["B-DFS1.2", "Master"])("readReportedError on a %s", (model) => {
    it.each([
        ["10 PRINT 1/0", "RUN", { number: 18, message: "Division by zero", lineNumber: 10 }],
        ["10 X=(1", "RUN", { number: 27, message: "Missing )", lineNumber: 10 }],
        ["10 PROCnone", "RUN", { number: 29, message: "No such FN/PROC", lineNumber: 10 }],
        ["10 STOP", "RUN", { number: 0, message: "STOP", lineNumber: 10 }],
        ['10 ON ERROR PRINT "caught":END\n20 X=1/0', "RUN", null],
        ["", "PRINT 1/0", { number: 18, message: "Division by zero", lineNumber: 0 }],
    ])("reads %j then %s as %j", async (program, command, expected) => {
        const machine = await bootedTestMachine(model);
        const cpu = machine.processor;
        const peek = (address) => cpu.peekmemAsLanguage(address);
        const { keywords } = basicRom(cpu.romBank(cpu.bankPagedBy(peek(LanguageRomNumber))));
        if (program) await machine.loadBasic(program);
        await machine.type(command);
        await machine.runUntilInput();
        expect(readReportedError(peek, keywords)).toEqual(expected);
    });
});
