"use strict";

import * as utils from "../utils.js";
import { fake6502 } from "../fake6502.js";

const processor = fake6502();
const irqRoutine = [
    0x48, 0x8a, 0x48, 0x98, 0x48, 0xba, 0xbd, 0x04, 0x01, 0x29, 0x10, 0xf0, 0x03, 0x6c, 0x16, 0x03, 0x6c, 0x14, 0x03,
];

function setup(filename) {
    for (let i = 0x0000; i < 0xffff; ++i) processor.writemem(i, 0x00);
    return utils.loadData("tests/suite/bin/" + filename).then(function (data) {
        const addr = data[0] + (data[1] << 8);
        console.log(">> Loading test '" + filename + "' at " + utils.hexword(addr));
        for (let i = 2; i < data.length; ++i) processor.writemem(addr + i - 2, data[i]);
        for (let i = 0; i < irqRoutine.length; ++i) processor.writemem(0xff48 + i, irqRoutine[i]);

        processor.writemem(0x0002, 0x00);
        processor.writemem(0xa002, 0x00);
        processor.writemem(0xa003, 0x80); // Docs say put zero here, but this works better.
        processor.writemem(0x01fe, 0xff);
        processor.writemem(0x01ff, 0x7f);

        // Put RTSes in some of the stubbed calls
        processor.writemem(0xffd2, 0x60);
        processor.writemem(0x8000, 0x60);
        processor.writemem(0xa474, 0x60);
        // NOP the loading routine
        processor.writemem(0xe16f, 0xea);
        // scan keyboard is LDA #3: RTS
        processor.writemem(0xffe4, 0xa9);
        processor.writemem(0xffe5, 0x03);
        processor.writemem(0xffe6, 0x60);
        processor.writemem(0xfffe, 0x48);
        processor.writemem(0xffff, 0xff);

        processor.s = 0xfd;
        processor.p.reset();
        processor.p.i = true;
        processor.pc = 0x0801;
    });
}

let curLine = "";

function petToAscii(char) {
    if (char === 14) return ""; // text mode
    if (char === 145) return ""; // up arrow
    if (char === 147) return "\n-------\n"; // Clear
    if (char >= 0xc1 && char <= 0xda) char = char - 0xc1 + 65;
    else if (char >= 0x41 && char <= 0x5a) char = char - 0x41 + 97;
    else if (char < 32 || char >= 127) {
        char = 46;
    }
    return String.fromCharCode(char);
}

processor.debugInstruction.add(function (addr) {
    switch (addr) {
        case 0xffd2:
            if (processor.a === 13) {
                console.log(curLine);
                curLine = "";
            } else {
                curLine += petToAscii(processor.a);
            }
            processor.writemem(0x030c, 0x00);
            break;
        case 0xe16f: {
            const filenameAddr = processor.readmem(0xbb) | (processor.readmem(0xbc) << 8);
            const filenameLen = processor.readmem(0xb7);
            let filename = "";
            for (let i = 0; i < filenameLen; ++i) filename += petToAscii(processor.readmem(filenameAddr + i));
            if (filename === "trap17") {
                console.log("All tests complete");
                process.exit(0);
            }

            setup(filename).then(anIter);
            processor.pc--; // Account for the instruction fetch
            return true; // Break out of the 'anIter' loop
        }
        case 0x8000:
        case 0xa474: // Fail
            if (curLine.length) console.log(curLine);
            throw "Test failed";

        default:
            break;
    }
    return false;
});

function anIter() {
    for (;;) {
        if (!processor.execute(10 * 1000 * 1000)) return;
    }
}

processor
    .initialise()
    .then(function () {
        if (process.argv.length === 3) {
            return setup(process.argv[2]);
        } else {
            return setup(" start");
        }
    })
    .then(anIter);
