import { describe, expect, it } from "vitest";

import { parseBaronListing, sectionNamed } from "../../../../tools/symbols/baron-listing.js";

const BytesWidth = 28;
const hex4 = (address) => address.toString(16).toUpperCase().padStart(4, "0");
const statement = (address, bytes, text = "") =>
    `  ${hex4(address)}  ${bytes
        .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ")
        .padEnd(BytesWidth)}${text}`;
const label = (address, name) => `  ${hex4(address)}  .${name}`;

const listing = [
    statement(0, [], 'INCLUDE "os.6502inc"'),
    "OSWRCH = 65518 [&FFEE]",
    "OSBYTE = 65524 [&FFF4]",
    statement(0, [], 'INCLUDE "consts.6502inc"'),
    "ptr = 112 [&70]",
    'SECTION main, filename="MAIN", org=&1900, load=&1900, exec=&1900',
    label(0x1900, "main"),
    "{",
    label(0x1900, "loop"),
    statement(0x1900, [0xa9, 0x00], "LDA #0"),
    statement(0x1902, [0x85, 0x70], "sta ptr"),
    "count = 113 [&71]",
    "}",
    label(0x1904, "table"),
    statement(0x1904, [1, 2, 3, 4, 5, 6, 7, 8], "EQUB 1,2,3,4,5,6,7,8,9,10"),
    statement(0x190c, [9, 10]),
    statement(0x190e, [0, 0], "SKIP 2"),
    "{",
    label(0x1910, "hidden"),
    "inner = 1",
    statement(0x1910, [0x60], "RTS"),
    "}",
    "SECTION moved, org=&0400",
    label(0x0400, "moved_code"),
    statement(0x0400, [0x4c, 0x00, 0x04], "JMP moved_code"),
    "ENDSECTION",
    statement(0x1914, [0xea], "NOP"),
    "ENDSECTION",
].join("\n");

describe("parseBaronListing", () => {
    const parsed = parseBaronListing(listing);
    const main = sectionNamed(parsed, "main");
    const moved = sectionNamed(parsed, "moved");

    it("reads each section's header, start and end", () => {
        expect(main.filename).toBe("MAIN");
        expect(main.exec).toBe(0x1900);
        expect([main.org, main.end]).toEqual([0x1900, 0x1915]);
        expect(moved.filename).toBeNull();
        expect(moved.exec).toBeNull();
        expect([moved.org, moved.end]).toEqual([0x0400, 0x0403]);
    });

    it("joins a statement's lines of bytes alone", () => {
        const table = main.statements.find((s) => s.address === 0x1904);
        expect(table.data).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(table.code).toBe(false);
    });

    it("tells instructions, their operands and padding", () => {
        const store = main.statements.find((s) => s.address === 0x1902);
        expect(store.mnemonic).toBe("STA");
        expect(store.code).toBe(true);
        expect(store.operand).toBe("ptr");
        expect(main.statements.find((s) => s.address === 0x190e).skip).toBe(true);
    });

    it("qualifies labels with their scopes, and keeps those in an anonymous scope apart", () => {
        expect(parsed.labels.map(({ name, address }) => [name, address])).toEqual([
            ["main", 0x1900],
            ["main.loop", 0x1900],
            ["table", 0x1904],
            ["moved_code", 0x0400],
        ]);
        expect(parsed.internalLabels.map(({ name }) => name)).toEqual(["@.hidden"]);
        expect(parsed.labels[1].scope).toEqual(["main"]);
    });

    it("records each named scope's `=` names with the scope they're in", () => {
        expect([...parsed.assigns]).toEqual([
            ["OSWRCH", []],
            ["OSBYTE", []],
            ["ptr", []],
            ["main.count", ["main"]],
        ]);
    });

    it("gives the names an INCLUDE assigns before anything else", () => {
        expect(parsed.includedNames.get("os.6502inc")).toEqual(new Set(["OSWRCH", "OSBYTE"]));
        expect(parsed.includedNames.get("consts.6502inc")).toEqual(new Set(["ptr"]));
    });

    it("stores a section inside another in its parent's stream, and runs it where it was assembled for", () => {
        expect(moved.parent).toBe(main);
        expect(moved.storedAt).toBe(0x1911);
        expect(moved.memory()).toEqual(
            new Map([
                [0x0400, 0x4c],
                [0x0401, 0x00],
                [0x0402, 0x04],
            ]),
        );
        const image = main.image();
        expect([0x1911, 0x1912, 0x1913, 0x1914].map((a) => image.get(a))).toEqual([0x4c, 0x00, 0x04, 0xea]);
        expect(image.has(0x0400)).toBe(false);
    });

    it("counts SKIPTO as padding, as SKIP is, in any case", () => {
        const padded = parseBaronListing(
            [
                "SECTION pad, org=&2000",
                statement(0x2000, [0, 0, 0, 0], "SKIPTO &2004"),
                statement(0x2004, [0, 0], "skip 2"),
                "ENDSECTION",
            ].join("\n"),
        );
        expect(padded.statements.map((s) => s.skip)).toEqual([true, true]);
    });

    it("reads an INCLUDE written in lower case", () => {
        const included = parseBaronListing(
            [statement(0, [], 'include "os.6502inc"'), "OSWRCH = 65518 [&FFEE]"].join("\n"),
        );
        expect(included.includedNames.get("os.6502inc")).toEqual(new Set(["OSWRCH"]));
    });

    it("refuses a section name that isn't there", () => {
        expect(() => sectionNamed(parsed, "nowhere")).toThrow("nowhere");
    });
});
