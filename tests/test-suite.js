"use strict";

import * as utils from "../src/utils.js";
import { fake6502 } from "../src/fake6502.js";

const processor = fake6502();
const IRQ_ROUTINE_START = 0xff48;
const RTS_OPCODE = 0x60;
const NOP_OPCODE = 0xea;

// prettier-ignore
const IRQ_ROUTINE = [
    0x48, // PHA
    0x8a, // TXA
    0x48, // PHA
    0x98, // TYA
    0x48, // PHA
    0xba, // TSX
    0xbd, 0x04, 0x01, // LDA $0104,X
    0x29, 0x10, // AND #$10
    0xf0, 0x03, // BEQ $03
    0x6c, 0x16, 0x03, // JMP ($0316)
    0x6c, 0x14, 0x03 // JMP ($0314)
];

async function setup(filename) {
    try {
        initializeMemory();
        await loadTest(filename);
        setupIRQRoutine();
        setupProcessor();
    } catch (error) {
        console.error(`Error in setup: ${error.message}`);
    }
}

function initializeMemory() {
    for (let i = 0x0000; i < 0xffff; ++i) processor.writemem(i, 0x00);
}

async function loadTest(filename) {
    const data = await utils.loadData(`tests/suite/bin/${filename}`);
    const addr = data[0] + (data[1] << 8);
    console.log(`>> Loading test '${filename}' at ${utils.hexword(addr)}`);
    for (let i = 2; i < data.length; ++i) processor.writemem(addr + i - 2, data[i]);
}

function setupIRQRoutine() {
    for (let i = 0; i < IRQ_ROUTINE.length; ++i) processor.writemem(IRQ_ROUTINE_START + i, IRQ_ROUTINE[i]);
}

function setupProcessor() {
    processor.writemem(0x0002, 0x00);
    processor.writemem(0xa002, 0x00);
    processor.writemem(0xa003, 0x80);
    processor.writemem(0x01fe, 0xff);
    processor.writemem(0x01ff, 0x7f);
    processor.writemem(0xffd2, RTS_OPCODE);
    processor.writemem(0x8000, RTS_OPCODE);
    processor.writemem(0xa474, RTS_OPCODE);
    processor.writemem(0xe16f, NOP_OPCODE);
    processor.writemem(0xffe4, 0xa9);
    processor.writemem(0xffe5, 0x03);
    processor.writemem(0xffe6, RTS_OPCODE);
    processor.writemem(0xfffe, 0x48);
    processor.writemem(0xffff, 0xff);
    processor.s = 0xfd;
    processor.p.reset();
    processor.p.i = true;
    processor.pc = 0x0801;
}

let curLine = "";

function petToAscii(char) {
    if (char === 14 || char === 145) return "";
    if (char === 147) return "\n-------\n";
    if (char >= 0xc1 && char <= 0xda) return String.fromCharCode(char - 0xc1 + 65);
    if (char >= 0x41 && char <= 0x5a) return String.fromCharCode(char - 0x41 + 97);
    if (char < 32 || char >= 127) return ".";
    return String.fromCharCode(char);
}

processor.debugInstruction.add((addr) => {
    switch (addr) {
        case 0xffd2:
            handlePrint();
            break;
        case 0xe16f:
            return handleLoad();
        case 0x8000:
        case 0xa474:
            handleError();
            break;
        default:
            break;
    }
    return false;
});

function handlePrint() {
    if (processor.a === 13) {
        console.log(curLine);
        curLine = "";
    } else {
        curLine += petToAscii(processor.a);
    }
    processor.writemem(0x030c, 0x00);
}

function handleLoad() {
    const filenameAddr = processor.readmem(0xbb) | (processor.readmem(0xbc) << 8);
    const filenameLen = processor.readmem(0xb7);
    let filename = "";
    for (let i = 0; i < filenameLen; ++i) filename += petToAscii(processor.readmem(filenameAddr + i));
    if (filename === "trap17") {
        console.log("All tests complete");
        process.exit(0);
    }
    setup(filename).then(anIter);
    processor.pc--;
    return true;
}

function handleError() {
    if (curLine.length) console.log(curLine);
    throw new Error("Test failed");
}

function anIter() {
    for (;;) {
        if (!processor.execute(10 * 1000 * 1000)) return;
    }
}

async function main() {
    try {
        await processor.initialise();
        const filename = process.argv.length === 3 ? process.argv[2] : " start";
        await setup(filename);
        anIter();
    } catch (error) {
        console.error(`Error in main: ${error.message}`);
    }
}

main().then(() => {});
