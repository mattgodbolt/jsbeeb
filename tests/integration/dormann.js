"use strict";

import _ from "underscore";
import { describe, it } from "vitest";
import * as utils from "../../src/utils.js";
import { fake6502, fake65C02, fake65C12 } from "../../src/fake6502.js";

import assert from "assert";

const log = false;

async function runTest(processor, test, name) {
    const base = "tests/6502_65C02_functional_tests/bin_files/" + test;

    function parseSuccess(listing) {
        let expectedPc = null;
        let next = false;
        let successRe = /^\s*success\b\s*(;.*)?$/;
        _.each(listing.split("\n"), function (line) {
            if (next) {
                next = false;
                expectedPc = parseInt(line.match(/^([0-9a-fA-F]+)/)[1], 16);
                console.log("Found success address $" + utils.hexword(expectedPc));
            } else {
                next = !!line.match(successRe);
            }
        });
        if (expectedPc === null) throw "Unable to parse";
        return expectedPc;
    }

    const expectedPc = parseSuccess((await utils.loadData(base + ".lst")).toString());
    const data = await utils.loadData(base + ".bin");
    for (let i = 0; i < data.length; ++i) processor.writemem(i, data[i]);

    processor.pc = 0x400;
    processor.debugInstruction.add(function (addr) {
        if (log) {
            console.log(
                utils.hexword(addr) +
                    " : A=" +
                    utils.hexbyte(processor.a) +
                    " : X=" +
                    utils.hexbyte(processor.x) +
                    " : Y=" +
                    utils.hexbyte(processor.y) +
                    " : " +
                    processor.disassembler.disassemble(processor.pc)[0],
            );
        }

        // Stop once we get stuck at the same address.
        return addr === processor.getPrevPc(1);
    });
    console.log("Running Dormann " + name + " tests...");
    processor.execute(2000000 * 60);
    console.log(`Run complete at $${utils.hexword(processor.pc)}`);
    const result = processor.pc === expectedPc;
    if (!result) logFailure(processor);
    return result;
}

function logFailure(processor) {
    console.log("Failed at " + utils.hexword(processor.pc));
    console.log("Previous PCs:");
    for (let i = 1; i < 16; ++i) {
        console.log("  " + utils.hexword(processor.getPrevPc(i)));
    }
    console.log("A: " + utils.hexbyte(processor.a));
    console.log("X: " + utils.hexbyte(processor.x));
    console.log("Y: " + utils.hexbyte(processor.y));
    console.log("S: " + utils.hexbyte(processor.s));
    console.log("P: " + utils.hexbyte(processor.p.asByte()) + " " + processor.p.debugString());
    console.log(
        utils.hd(
            function (i) {
                return processor.readmem(i);
            },
            0x00,
            0x40,
        ),
    );
}

describe("dormann tests", { timeout: 30000 }, function () {
    it("should pass 6502 functional tests", async () => {
        const cpu = fake6502();
        await cpu.initialise();
        assert(await runTest(cpu, "6502_functional_test", "6502"));
    });
    it("should pass 65c02 extended opcode tests", async () => {
        const cpu = fake65C02();
        await cpu.initialise();
        assert(await runTest(cpu, "65C02_extended_opcodes_test", "65C02"));
    });
    it("should pass 65c12 extended opcode tests", async () => {
        const cpu = fake65C12();
        await cpu.initialise();
        assert(await runTest(cpu, "65C12_extended_opcodes_test", "65C12"));
    });
});
