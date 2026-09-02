import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fake6502, fake65C02, fake65C12 } from "../../src/fake6502.js";
import { TEST_65C02, TEST_65C12 } from "../../src/models.js";
import { RepoRoot } from "./helpers.js";

import assert from "assert";
import { hd, hexbyte, hexword } from "../../src/hex.js";

const log = false;
const BinDir = path.join(RepoRoot, "tests/6502_65C02_functional_tests/bin_files");

async function runTest(processor, test, name) {
    const base = path.join(BinDir, test);

    function parseSuccess(listing) {
        let expectedPc = null;
        let next = false;
        let successRe = /^\s*success\b\s*(;.*)?$/;
        for (const line of listing.split("\n")) {
            if (next) {
                next = false;
                expectedPc = parseInt(line.match(/^([0-9a-fA-F]+)/)[1], 16);
                console.log("Found success address $" + hexword(expectedPc));
            } else {
                next = !!line.match(successRe);
            }
        }
        if (expectedPc === null) throw "Unable to parse";
        return expectedPc;
    }

    const expectedPc = parseSuccess(readFileSync(base + ".lst", "utf8"));
    const data = readFileSync(base + ".bin");
    for (let i = 0; i < data.length; ++i) processor.writemem(i, data[i]);

    processor.pc = 0x400;
    processor.debugInstruction.add(function (addr) {
        if (log) {
            console.log(
                hexword(addr) +
                    " : A=" +
                    hexbyte(processor.a) +
                    " : X=" +
                    hexbyte(processor.x) +
                    " : Y=" +
                    hexbyte(processor.y) +
                    " : " +
                    processor.disassembler.disassemble(processor.pc)[0],
            );
        }

        // Stop once we get stuck at the same address.
        return addr === processor.getPrevPc(1);
    });
    console.log("Running Dormann " + name + " tests...");
    processor.execute(2000000 * 60);
    console.log(`Run complete at $${hexword(processor.pc)}`);
    const result = processor.pc === expectedPc;
    if (!result) logFailure(processor);
    return result;
}

function logFailure(processor) {
    console.log("Failed at " + hexword(processor.pc));
    console.log("Previous PCs:");
    for (let i = 1; i < 16; ++i) {
        console.log("  " + hexword(processor.getPrevPc(i)));
    }
    console.log("A: " + hexbyte(processor.a));
    console.log("X: " + hexbyte(processor.x));
    console.log("Y: " + hexbyte(processor.y));
    console.log("S: " + hexbyte(processor.s));
    console.log("P: " + hexbyte(processor.p.asByte()) + " " + processor.p.debugString());
    console.log(
        hd(
            function (i) {
                return processor.readmem(i);
            },
            0x00,
            0x40,
        ),
    );
}

describe("dormann tests", function () {
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

describe("dormann tests (non-cycle-accurate)", function () {
    it("should pass 6502 functional tests", async () => {
        const cpu = fake6502(undefined, { cycleAccurate: false });
        await cpu.initialise();
        assert(await runTest(cpu, "6502_functional_test", "6502 (non-cycle-accurate)"));
    });
    it("should pass 65c02 extended opcode tests", async () => {
        const cpu = fake6502(TEST_65C02, { cycleAccurate: false });
        await cpu.initialise();
        assert(await runTest(cpu, "65C02_extended_opcodes_test", "65C02 (non-cycle-accurate)"));
    });
    it("should pass 65c12 extended opcode tests", async () => {
        const cpu = fake6502(TEST_65C12, { cycleAccurate: false });
        await cpu.initialise();
        assert(await runTest(cpu, "65C12_extended_opcodes_test", "65C12 (non-cycle-accurate)"));
    });
});
