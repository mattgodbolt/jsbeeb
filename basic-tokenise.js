"use strict";
import * as utils from "./utils.js";
import * as models from "./models.js";
import { fake6502 } from "./fake6502.js";

export async function create() {
    const cpu = fake6502(models.basicOnly);
    const callTokeniser = function (line) {
        // Address of the tokenisation subroutine in the Master's BASIC ROM.
        // With thanks to http://8bs.com/basic/basic4-8db2.htm
        const tokeniseBASIC = 0x8db2;
        // Address of the instruction to intercept where the tail is copied down.
        const copyIntercept = 0x8ea1;
        // Set the stack top to this, then execute until the CPU pops past this.
        const stackTop = 0xf0;
        // Address to inject the BASIC program text at.
        const workSpace = 0x1000;
        // Pointer to the program text.
        const textPtrLo = 0x37;
        const textPtrHi = 0x38;

        cpu.pc = tokeniseBASIC;
        cpu.s = stackTop;
        let offset = workSpace;
        // Set flags to indicate that we're at the start of a statement
        // but have already processed the line number.
        cpu.writemem(0x3b, 0x00);
        cpu.writemem(0x3c, 0x00);
        cpu.writemem(textPtrLo, offset & 0xff);
        cpu.writemem(textPtrHi, (offset >>> 8) & 0xff);
        // Set the paged ROM latch to page in the BASIC.
        cpu.writemem(0xfe30, 12);
        for (let i = 0; i < line.length; ++i) {
            cpu.writemem(offset + i, line.charCodeAt(i));
        }
        cpu.writemem(offset + line.length, 0x0d);
        let safety = 20 * 1000 * 1000;
        let result = "";
        while (cpu.s <= stackTop) {
            cpu.execute(1);
            if (--safety === 0) {
                break;
            }
            if (cpu.pc === copyIntercept) {
                // Intercept the subroutine in the BASIC ROM which replaces a keyword
                // with a token and copies down the tail of the line.  The 6502 code
                // uses the Y register to index the copy and fails if the untokenised
                // tail is longer than 255 bytes.  It also makes tokenisation O(n²)
                // for a line with a lot of tokens.
                //
                // Instead we copy out the newly processed part and advance the pointer
                // to the unprocessed part.
                let to = (cpu.readmemZpStack(textPtrHi) << 8) | cpu.readmemZpStack(textPtrLo);
                while (offset < to) {
                    result += String.fromCharCode(cpu.readmem(offset));
                    offset++;
                }
                result += String.fromCharCode(cpu.a);
                offset += cpu.y;
                cpu.writememZpStack(textPtrLo, offset & 0xff);
                cpu.writememZpStack(textPtrHi, (offset >>> 8) & 0xff);
                ++offset;
                // Skip over the JSR instruction.
                cpu.pc += 3;
            }
        }
        for (let i = offset; cpu.readmem(i) !== 0x0d; ++i) {
            result += String.fromCharCode(cpu.readmem(i));
        }
        if (safety === 0) {
            throw new Error(
                "Unable to tokenize '" + line + "' - got as far as '" + result + "' pc=" + utils.hexword(cpu.pc),
            );
        }
        return result;
    };
    const lineRe = /^([0-9]+)?(.*)/;
    const tokeniseLine = function (line, lineNumIfNotSpec) {
        const lineSplit = line.match(lineRe);
        const lineNum = lineSplit[1] ? parseInt(lineSplit[1]) : lineNumIfNotSpec;
        const tokens = callTokeniser(lineSplit[2]);
        if (tokens.length > 251) {
            throw new Error("Line " + lineNum + " tokenised length " + tokens.length + " > 251 bytes");
        }
        return (
            "\r" +
            String.fromCharCode((lineNum >>> 8) & 0xff) +
            String.fromCharCode(lineNum & 0xff) +
            String.fromCharCode(tokens.length + 4) +
            tokens
        );
    };
    const tokenise = function (text) {
        let result = "";
        text.split("\n").forEach(function (line, i) {
            if (line) {
                result += tokeniseLine(line, 10 + i * 10);
            }
        });
        return result + "\r\xff";
    };
    await cpu.initialise();
    return { tokenise };
}
