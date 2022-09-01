"use strict";

import _ from "underscore";
import * as utils from "../utils.js";
import { fake6502, fake65C12 } from "../fake6502.js";

function runTest(processor, test, name) {
    let base = "tests/6502_65C02_functional_tests/bin_files/" + test;

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

    return Promise.all([utils.loadData(base + ".lst"), utils.loadData(base + ".bin")]).then(function (results) {
        let expectedPc = parseSuccess(results[0].toString());
        let data = results[1];
        for (let i = 0; i < data.length; ++i) processor.writemem(i, data[i]);
        processor.pc = 0x400;
        let log = false;
        processor.debugInstruction.add(function (addr) {
            if (log) {
                console.log(
                    utils.hexword(addr) +
                        " : " +
                        utils.hexbyte(processor.a) +
                        " : " +
                        processor.disassembler.disassemble(processor.pc)[0]
                );
            }

            return addr !== 0x400 && addr === processor.getPrevPc(1);
        });
        console.log("Running Dormann " + name + " tests...");
        while (processor.execute(1000000)) {
            // do nothing
        }
        return processor.pc === expectedPc;
    });
}

function fail(processor) {
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
            0x40
        )
    );
    process.exit(1);
}

let cpu6502 = fake6502();
let test6502 = cpu6502
    .initialise()
    .then(function () {
        return runTest(cpu6502, "6502_functional_test", "6502");
    })
    .then(function (success) {
        if (!success) fail(cpu6502);
    });

let test65c12 = test6502.then(function () {
    let cpu65c12 = fake65C12();
    return cpu65c12
        .initialise()
        .then(function () {
            return runTest(cpu65c12, "65C12_extended_opcodes_test", "65C12");
        })
        .then(function (success) {
            if (!success) fail(cpu65c12);
        });
});

test65c12
    .then(function () {
        console.log("Success!");
    })
    .catch(function (e) {
        console.log("Exception in test: ", e);
        process.exit(1);
    });
