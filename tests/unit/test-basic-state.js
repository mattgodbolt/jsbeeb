import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
    basicRom,
    formatReal,
    listStatements,
    readPointers,
    readReportedError,
    readVariables,
    readWait,
} from "../../src/basic-state.js";
import { RepoRoot } from "../../src/test-machine.js";

const RomBankBytes = 16 * 1024;

/** A peek over 64K of memory holding `bytes` from each address given. */
function memory(writes) {
    const ram = new Uint8Array(0x10000);
    for (const [address, bytes] of writes) ram.set(bytes, address);
    return (address) => ram[address & 0xffff];
}

const ascii = (text) => [...text].map((char) => char.charCodeAt(0));

describe("basicRom", () => {
    it.each([
        ["BASIC.ROM", 0, 0x8ba7, 0x8bad],
        ["a01/BASIC1.rom", 0, 0x8b18, 0x8b1e],
        ["us/USBASIC.rom", 0, 0x8bc2, 0x8bc8],
        ["compact/basic48.rom", 0, 0x8ff0, 0x8ff6],
        ["compact/basic486.rom", 0, 0x8ff0, 0x8ff6],
        ["master/mos3.20", 4, 0x900f, 0x9015],
    ])("finds where %s (bank %i) reads and starts each statement, and its keywords", (file, bank, read, start) => {
        const image = readFileSync(path.join(RepoRoot, "public/roms", file));
        const basic = basicRom(image.subarray(bank * RomBankBytes, (bank + 1) * RomBankBytes));
        expect([basic.statementRead, basic.statementStart]).toEqual([read, start]);
        expect([basic.keywords.get(0x80), basic.keywords.get(0xf1), basic.keywords.get(0xf4)]).toEqual([
            "AND",
            "PRINT",
            "REM",
        ]);
    });

    it("finds nothing in a ROM that is not BASIC", () => {
        expect(basicRom(readFileSync(path.join(RepoRoot, "public/roms/b/DFS-1.2.rom")))).toBe(null);
    });
});

describe("readVariables", () => {
    const heap = [0x00, [0x00, 0x30, 0x00, 0x40]];

    it("ends a chain at a link whose high byte is zero, whatever its low byte", () => {
        const peek = memory([heap, [0x482, [0x00, 0x30]], [0x3000, [0xff, 0x00, ...ascii("pple%"), 0, 7, 0, 0, 0]]]);
        expect(readVariables(peek).variables).toEqual([{ name: "Apple%", value: "7" }]);
    });

    it("reads each entry once, and only in the heap, however the links in memory that is not BASIC's run", () => {
        const peek = memory([heap, [0x400, new Array(0x100).fill(0x31)], [0x3000, new Array(0x1000).fill(0x31)]]);
        const { variables, routines } = readVariables(peek);
        expect(variables.length + routines.length).toBe(1);
    });
});

describe("readPointers", () => {
    it("reads the statement and expression pointers each as the character last read", () => {
        const peek = memory([
            [0x0a, [3, 0x00, 0x19]],
            [0x19, [0x10, 0x19, 5]],
        ]);
        const { reading, expression } = readPointers(peek);
        expect([reading, expression]).toEqual([0x1902, 0x1914]);
    });
});

describe("readReportedError", () => {
    const keywords = new Map([[0xf1, "PRINT"]]);
    const division = [18, ...ascii("Division by zero"), 0];

    it.each([
        ["an expression pointer below the ROM", 0x7fff, division, null],
        ["one at the ROM's start", 0x8000, division, { number: 18, message: "Division by zero", lineNumber: 10 }],
        ["one at its last byte", 0xbfff, division, { number: 18, message: "Division by zero", lineNumber: 10 }],
        ["one past it", 0xc000, division, null],
        ["tokens", 0x8000, [27, 0x8d, 0x29, 0x20, 0xf1, 0], { number: 27, message: "Missing ) PRINT", lineNumber: 10 }],
        ["what does not print", 0x8000, [1, 0x07, 0x7f, 0xfe, 0], { number: 1, message: "...", lineNumber: 10 }],
        [
            "a block with no end",
            0x8000,
            new Array(300).fill(0x41),
            { number: 0x41, message: "A".repeat(255), lineNumber: 10 },
        ],
    ])("reads %s", (_, expression, block, expected) => {
        const peek = memory([
            [0x08, [10, 0]],
            [0x19, [expression & 0xff, expression >> 8]],
            [0xfd, [0x00, 0x30]],
            [0x3000, block],
        ]);
        expect(readReportedError(peek, keywords)).toEqual(expected);
    });
});

describe("listStatements", () => {
    it("splits a line at colons, but not in strings, nor after REM, DATA or a star command", () => {
        const text = [...ascii(' A$="a:b":'), 0xf4, ...ascii(" x:y")];
        const line = { number: 10, start: 0x1900, end: 0x1904 + text.length };
        const peek = memory([[0x1904, text]]);
        const keywords = new Map([[0xf4, "REM"]]);
        expect(listStatements(peek, line, keywords).map(({ text }) => text)).toEqual([' A$="a:b"', "REM x:y"]);
        const star = ascii(" *FX 200,3:X=1");
        expect(
            listStatements(memory([[0x1904, star]]), { ...line, end: 0x1904 + star.length }, keywords).map(
                ({ text }) => text,
            ),
        ).toEqual([" *FX 200,3:X=1"]);
    });
});

describe("readWait", () => {
    const keywords = new Map([
        [0xa5, "GET"],
        [0xbe, "GET$"],
        [0xa6, "INKEY"],
        [0xe8, "INPUT"],
        [0x86, "LINE"],
        [0xe7, "IF"],
        [0x8c, "THEN"],
        [0x8b, "ELSE"],
        [0xf5, "REPEAT"],
        [0xfd, "UNTIL"],
        [0xd4, "SOUND"],
        [0xf1, "PRINT"],
    ]);
    const tokens = Object.fromEntries([...keywords].map(([token, keyword]) => [keyword, token]));
    const Text = 0x1904;
    const ReadCharacter = 0xdec5;

    /**
     * A CPU at `pc` with an empty stack over memory holding a line of `parts` (text, or a keyword's token), BASIC's
     * statement pointer at the part numbered `reading` and its expression pointer at the part numbered `expression`.
     */
    function machine(parts, { reading, expression = reading, pc = ReadCharacter }) {
        const bytes = parts.flatMap((part) => (part in tokens ? [tokens[part]] : ascii(part)));
        const at = (part) =>
            Text + parts.slice(0, part).reduce((length, p) => length + (p in tokens ? 1 : p.length), 0);
        const pointer = (address) => [1, address & 0xff, address >> 8];
        const peek = memory([
            [0x0a, pointer(at(reading))],
            [0x1b - 2, [at(expression) & 0xff, at(expression) >> 8, 1]],
            [0x210, [ReadCharacter & 0xff, ReadCharacter >> 8]],
            [Text, [...bytes, 0x0d]],
        ]);
        const line = { number: 10, start: Text - 4, end: Text + bytes.length };
        const cpu = {
            peekmemAsLanguage: peek,
            pc,
            s: 0xff,
            disassembler: { instructionAt: () => ({ accesses: [], flow: "return", next: pc + 1 }) },
            isBankPagedAt: () => false,
            bankPagedBy: (rom) => rom,
        };
        return { cpu, line };
    }

    it.each([
        ["GET at the expression pointer", ["A=", "GET"], { reading: 0, expression: 1 }, "GET"],
        ["the later of two", ["PRINT", "GET", ";", "GET$"], { reading: 0, expression: 3 }, "GET$"],
        ["the earlier while it waits there", ["PRINT", "GET", ";", "GET$"], { reading: 0, expression: 1 }, "GET"],
        ["INPUT after THEN", ['A$="":', "IF", 'A$="" ', "THEN", " ", "INPUT", " A$"], { reading: 6 }, "INPUT"],
        ["INPUT LINE after ELSE", ["IF", "X ", "ELSE", "INPUT", " ", "LINE", " A$"], { reading: 6 }, "INPUT LINE"],
        ["INPUT after REPEAT", ["REPEAT", " ", "INPUT", " A$ ", "UNTIL", "0"], { reading: 3 }, "INPUT"],
        ["LINE only straight after INPUT", ["INPUT", "SPC(3) ", "LINE", "A$"], { reading: 3 }, "INPUT"],
        ["a colon in a string", ["INPUT", ' "a:b" A$'], { reading: 1 }, "INPUT"],
        ["the statement after the colon", ["A=", "GET", ":", "INPUT", " B"], { reading: 4 }, "INPUT"],
        ["a statement read from the colon before it", ["X=1", ":", "A=", "GET"], { reading: 1, expression: 3 }, "GET"],
        ["none in this statement", ["INPUT", " A:", "X=USR(&FFE0)"], { reading: 2 }, null],
    ])("names the keyword a key is waited for in: %s", (_, parts, pointers, keyword) => {
        const { cpu, line } = machine(parts, pointers);
        expect(readWait(cpu, line, keywords)).toEqual({ kind: "keyboard", keyword });
    });

    it("names no keyword without a line", () => {
        const { cpu } = machine(["A=", "GET"], { reading: 1 });
        expect(readWait(cpu, null, keywords)).toEqual({ kind: "keyboard", keyword: null });
    });

    it.each([
        ["in SOUND, on the colon after it", ["SOUND", "1,2,3,4", ":X=1"], { reading: 2, expression: 1 }, true],
        ["after THEN", ["IF", "1 ", "THEN", "SOUND", "1,2,3,4"], { reading: 4 }, true],
        ["in the ELSE part after it", ["IF", "0 ", "THEN", "SOUND", "1,2,3,4 ", "ELSE", "X=1"], { reading: 6 }, false],
        ["in the statement after it", ["SOUND", "1,2,3,4", ":X=1"], { reading: 2, expression: 2 }, false],
    ])("reads a SOUND statement %s", (_, parts, pointers, sound) => {
        const { cpu, line } = machine(parts, { ...pointers, pc: 0x2000 });
        expect(readWait(cpu, line, keywords)).toEqual(sound ? { kind: "sound", keyword: null } : null);
    });

    // ROM 9's address and number in FILEV's three bytes of the extended vector table, and ROM 9 paged in at the PC.
    it.each([
        ["extended by ROM 9", 0xff1b, { kind: "filing system", keyword: null }],
        ["the OS's own, as the tape filing system is", 0xf247, null],
    ])("reads a PC in ROM 9 with FILEV %s", (_, filev, expected) => {
        const { cpu, line } = machine(["X=1"], { reading: 0, pc: 0x8100 });
        const peek = cpu.peekmemAsLanguage;
        const fileVector = { 0x212: filev & 0xff, 0x213: filev >> 8, 0xdba: 0x00, 0xdbb: 0x81, 0xdbc: 9 };
        cpu.peekmemAsLanguage = (address) => fileVector[address] ?? peek(address);
        cpu.isBankPagedAt = (bank, address) => bank === 9 && address === cpu.pc;
        expect(readWait(cpu, line, keywords)).toEqual(expected);
    });
});

describe("formatReal", () => {
    it("prints as PRINT does with the default @%", () => {
        const values = [0, 3.5, -0.5, 0.1, 0.01, 1 / 3, 123456789, 1234567891, 1e9, 2 ** 31, -2.5e-5];
        expect(values.map(formatReal)).toEqual([
            "0",
            "3.5",
            "-0.5",
            "0.1",
            "1E-2",
            "0.333333333",
            "123456789",
            "1.23456789E9",
            "1E9",
            "2.14748365E9",
            "-2.5E-5",
        ]);
    });
});
