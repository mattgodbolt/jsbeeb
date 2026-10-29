import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { basicRom, formatReal, listStatements, readVariables } from "../../src/basic-state.js";
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
        ["BASIC.ROM", 0, 0x8bad],
        ["a01/BASIC1.rom", 0, 0x8b1e],
        ["us/USBASIC.rom", 0, 0x8bc8],
        ["compact/basic48.rom", 0, 0x8ff6],
        ["compact/basic486.rom", 0, 0x8ff6],
        ["master/mos3.20", 4, 0x9015],
    ])("finds where %s (bank %i) starts each statement, and its keywords", (file, bank, statementStart) => {
        const image = readFileSync(path.join(RepoRoot, "public/roms", file));
        const basic = basicRom(image.subarray(bank * RomBankBytes, (bank + 1) * RomBankBytes));
        expect(basic.statementStart).toBe(statementStart);
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
