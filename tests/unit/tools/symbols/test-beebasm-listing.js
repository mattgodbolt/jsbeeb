import { describe, expect, it } from "vitest";

import {
    labelName,
    memoryOperand,
    parseBeebasmListing,
    parseLabelDump,
} from "../../../../tools/symbols/beebasm-listing.js";

const Prefix = "@test";
const BytesWidth = 11;
const hex2 = (byte) => byte.toString(16).toUpperCase().padStart(2, "0");
const hex4 = (address) => address.toString(16).toUpperCase().padStart(4, "0");
const instruction = (address, bytes, text) =>
    `     ${hex4(address)}   ${bytes.map(hex2).join(" ").padEnd(BytesWidth)}${text}`;
const data = (address, bytes) => `     ${hex4(address)}   ${bytes.map(hex2).join(" ")}`;

const listing = [
    ".start",
    instruction(0x1900, [0xa9, 0x05], "LDA #&05"),
    instruction(0x1902, [0x85, 0x70], "STA &70"),
    "Macro BUMP:",
    instruction(0x1904, [0xe6, 0x71], "INC &71,X"),
    "End macro BUMP",
    instruction(0x1906, [0xd0, 0xf8], "BNE &1900"),
    instruction(0x1908, [0x0a], "ASL A"),
    instruction(0x1909, [0xb1, 0x70], "LDA (&70),Y"),
    instruction(0x190b, [0x6c, 0x04, 0x02], "JMP (&0204)"),
    ".table",
    data(0x190e, [0x01]),
    data(0x190f, [0x34, 0x12]),
    `     1911   48 45 4C ...`,
    `     1917   41 42 `,
    `     1919   01 02 03 ... INCBIN "blob"`,
    "     1929",
    "Saving file 'PROG'",
    `${Prefix}:ptr:112 `,
    `${Prefix}:greeting:a:b`,
].join("\n");

describe("parseBeebasmListing", () => {
    const parsed = parseBeebasmListing(listing, Prefix);
    const at = (address) => parsed.statements.find((s) => s.address === address);

    it("reads each instruction's bytes, mnemonic and the memory it names", () => {
        expect(at(0x1902)).toMatchObject({ bytes: [0x85, 0x70], code: true, mnemonic: "STA", target: 0x70 });
        expect(at(0x1904)).toMatchObject({ mnemonic: "INC", target: 0x71 });
        expect(at(0x1909).target).toBe(0x70);
        expect(at(0x190b)).toMatchObject({ bytes: [0x6c, 0x04, 0x02], target: 0x0204 });
    });

    it("takes no memory from an immediate, a branch or the accumulator", () => {
        expect(at(0x1900).target).toBeNull();
        expect(at(0x1906).target).toBeNull();
        expect(at(0x1908)).toMatchObject({ bytes: [0x0a], mnemonic: "ASL", target: null });
    });

    it("reads data, and marks what the listing cuts short and what it shows no bytes for", () => {
        expect(at(0x190e)).toMatchObject({ bytes: [0x01], code: false, truncated: false, skip: false });
        expect(at(0x190f).bytes).toEqual([0x34, 0x12]);
        expect(at(0x1911)).toMatchObject({ bytes: [0x48, 0x45, 0x4c], truncated: true });
        expect(at(0x1917)).toMatchObject({ bytes: [0x41, 0x42], truncated: false });
        expect(at(0x1919)).toMatchObject({ bytes: [1, 2, 3], code: false, truncated: true });
        expect(at(0x1929)).toMatchObject({ bytes: [], skip: true });
    });

    it("keeps every statement, label and save in listing order", () => {
        expect(parsed.statements).toHaveLength(13);
        expect(parsed.labels.map(({ name }) => name)).toEqual(["start", "table"]);
        expect(parsed.saves.map(({ file }) => file)).toEqual(["PROG"]);
        const orders = [...parsed.statements, ...parsed.labels, ...parsed.saves].map(({ order }) => order);
        expect(new Set(orders).size).toBe(orders.length);
        expect(parsed.labels[1].order).toBeLessThan(at(0x190e).order);
        expect(parsed.saves[0].order).toBeGreaterThan(at(0x1929).order);
    });

    it("gives the values the importer's PRINTs wrote, and nothing for the source's own PRINTs", () => {
        expect([...parsed.printed]).toEqual([
            ["ptr", "112"],
            ["greeting", "a:b"],
        ]);
        expect(parseBeebasmListing("SYM lives&28CC", Prefix).printed.size).toBe(0);
    });
});

describe("memoryOperand", () => {
    it("is the address an operand starts with, unless it's a branch's", () => {
        expect(memoryOperand("LDA", "&3010,X")).toBe(0x3010);
        expect(memoryOperand("STA", "(&70,X)")).toBe(0x70);
        expect(memoryOperand("BRA", "&1900")).toBeNull();
        expect(memoryOperand("LDA", "#&70")).toBeNull();
        expect(memoryOperand("RTS", undefined)).toBeNull();
    });
});

describe("parseLabelDump", () => {
    it("reads every label in order, repeats and all", () => {
        expect(parseLabelDump("[{'.start':6400L,'.start.inner':6400L,'._i_1.lp':6423L,'._i_1.lp':6424L}]\n")).toEqual([
            { identifier: ".start", address: 0x1900 },
            { identifier: ".start.inner", address: 0x1900 },
            { identifier: "._i_1.lp", address: 0x1917 },
            { identifier: "._i_1.lp", address: 0x1918 },
        ]);
    });
});

describe("labelName", () => {
    const labelled = new Set([".scan_keys", ".main", ".fin", "._row_0"]);

    it("joins a label's scopes", () => {
        expect(labelName(".scan_keys.not_down", labelled)).toEqual({
            name: "scan_keys.not_down",
            scope: ["scan_keys"],
            internal: false,
        });
        expect(labelName(".main", labelled)).toEqual({ name: "main", scope: [], internal: false });
    });

    it("marks a label in a scope beebasm named itself: a brace with no label, a FOR loop's pass, a macro's call", () => {
        expect(labelName("._288.src", labelled).internal).toBe(true);
        expect(labelName(".fin._i_0.lp", labelled).internal).toBe(true);
        expect(labelName("._3.ml", labelled).internal).toBe(true);
    });

    it("keeps a label in a scope a label of the source's names, whatever that label looks like", () => {
        expect(labelName("._row_0.next", labelled).internal).toBe(false);
        expect(labelName("._private", labelled).internal).toBe(false);
    });
});
