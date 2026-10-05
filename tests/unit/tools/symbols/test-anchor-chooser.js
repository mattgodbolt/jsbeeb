import { describe, expect, it } from "vitest";

import { blockedAddresses, candidates, chooseAnchors, storesIn } from "../../../../tools/symbols/anchor-chooser.js";

const Section = { name: "main" };
const OtherSection = { name: "other" };
const NoTables = { tableSizes: new Map(), moves: new Set() };
const Spread = { bytesPerAnchor: 0x100, spreadAnchors: 4 };

const code = (address, data, section = Section) => ({ address, data, code: true, skip: false, section });
const data = (address, bytes, section = Section) => ({ address, data: bytes, code: false, skip: false, section });

/** Distinct instructions, LDA #n then STA &3000+n, from `address` for `count` pairs. */
const routine = (address, count, seed = 0) =>
    Array.from({ length: count }, (_, i) => [
        code(address + i * 5, [0xa9, (seed + i) & 0xff]),
        code(address + i * 5 + 2, [0x8d, (seed + i) & 0xff, 0x30]),
    ]).flat();

function region({ start, end, statements, labels = [], exec = null, ...rest }) {
    const memory = new Map(statements.flatMap((s) => s.data.map((byte, i) => [s.address + i, byte])));
    return {
        name: "main",
        fullName: "test/main",
        imageName: "test:main",
        section: Section,
        sectionInfo: { org: start, end, exec, statements, labels },
        start,
        end,
        overwritten: false,
        avoid: [],
        osBlocks: new Set(),
        memory,
        ...rest,
    };
}

const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

describe("storesIn", () => {
    it("reaches a direct store's byte, and 256 bytes or all of zero page for an indexed one", () => {
        const { stores } = storesIn(
            [
                code(0x1900, [0x85, 0x70]),
                code(0x1902, [0x9d, 0x00, 0x20]),
                code(0x1905, [0x95, 0x10]),
                code(0x1907, [0xa9, 1]),
            ],
            NoTables,
        );
        expect(stores.map(({ first, last }) => [first, last])).toEqual([
            [0x70, 0x70],
            [0x2000, 0x20ff],
            [0x00, 0xff],
        ]);
    });

    it("reaches a table's size where it's given, and not at all for a move", () => {
        const table = { ...code(0x1900, [0x9d, 0x00, 0x01]), base: 0x100 };
        const move = code(0x1903, [0x99, 0x00, 0x04]);
        const { stores, used } = storesIn([table, move], {
            tableSizes: new Map([[0x100, 4]]),
            moves: new Set([0x1903]),
        });
        expect(stores.map(({ first, last }) => [first, last])).toEqual([[0x100, 0x103]]);
        expect(used).toEqual(new Set([0x100, 0x1903]));
    });

    it("leaves a table no store writes out of those it matched", () => {
        const { used } = storesIn([code(0x1900, [0x85, 0x70])], {
            tableSizes: new Map([[0x100, 4]]),
            moves: new Set(),
        });
        expect(used).toEqual(new Set());
    });
});

describe("blockedAddresses", () => {
    const statements = routine(0x1900, 20);

    it("keeps anchors off what the program stores to, the I/O pages, padding and the avoided ranges", () => {
        const padded = [...statements, { ...data(0x1964, [0, 0, 0, 0]), skip: true }];
        const blocked = blockedAddresses(
            region({ start: 0x1900, end: 0x1a00, statements: padded, avoid: [[0x1980, 0x1984]] }),
            [{ statement: statements[0], first: 0x1910, last: 0x1911 }],
        );
        expect([...blocked].sort((a, b) => a - b)).toEqual([
            0x1910,
            0x1911,
            ...range(0x1964, 0x1968),
            ...range(0x1980, 0x1984),
        ]);
        expect(blockedAddresses(region({ start: 0xfb00, end: 0xff10, statements: [] }), []).has(0xfc00)).toBe(true);
    });

    it("minds only its own stores in run-once code", () => {
        const elsewhere = code(0x0900, [0x8d, 0x10, 0x19], OtherSection);
        const own = statements[1];
        const blocked = blockedAddresses(region({ start: 0x1900, end: 0x1a00, statements, overwritten: true }), [
            { statement: elsewhere, first: 0x1900, last: 0x19ff },
            { statement: own, first: 0x1920, last: 0x1920 },
        ]);
        expect([...blocked]).toEqual([0x1920]);
    });

    it("leaves out a label named as dead code, up to the next label", () => {
        const labels = [
            { address: 0x1910, name: "spare_bytes" },
            { address: 0x1918, name: "next" },
        ];
        const blocked = blockedAddresses(region({ start: 0x1900, end: 0x1a00, statements, labels }), []);
        expect([...blocked].sort((a, b) => a - b)).toEqual(range(0x1910, 0x1918));
    });

    it("leaves out a block the code hands the OS, up to the next code or 18 bytes", () => {
        const block = data(0x1964, range(1, 40));
        const labels = [
            { address: 0x1964, name: "osfile_block" },
            { address: 0x1969, name: "osword_block" },
        ];
        const blocked = blockedAddresses(
            region({
                start: 0x1900,
                end: 0x1a00,
                statements: [...statements, block],
                labels,
                osBlocks: new Set([0x1964, 0x1969]),
            }),
            [],
        );
        expect([...blocked].sort((a, b) => a - b)).toEqual(range(0x1964, 0x1969 + 18));
    });

    it("leaves out a BASIC program's first line, its line headers and its REMs", () => {
        const line = (number, text) => [0x0d, number >> 8, number & 0xff, text.length + 4, ...text];
        const program = [
            ...line(10, [0xf4, 0x41]),
            ...line(20, [0x50, 0x2e, 0x22, 0xf4, 0x22, 0xf4, 0x42]),
            0x0d,
            0xff,
        ];
        const statement = data(0x1900, program);
        const blocked = blockedAddresses(
            region({ start: 0x1900, end: 0x1950, statements: [statement], exec: 0xffff8023 }),
            [],
        );
        expect([...blocked].sort((a, b) => a - b)).toEqual([...range(0x1900, 0x190a), 0x190f, 0x1910]);
    });
});

describe("candidates", () => {
    it("takes whole instructions from an instruction's start, aiming for six bytes and stopping at eight", () => {
        const found = candidates(region({ start: 0x1900, end: 0x1a00, statements: routine(0x1900, 4) }), new Set());
        expect(found[0]).toEqual({
            at: 0x1900,
            data: [0xa9, 0x00, 0x8d, 0x00, 0x30, 0xa9, 0x01],
            labelled: false,
            code: true,
        });
    });

    it("never anchors on a call into the MOS", () => {
        const statements = [code(0x1900, [0xa9, 0x01]), code(0x1902, [0x20, 0xee, 0xff]), code(0x1905, [0xa2, 0x02])];
        expect(candidates(region({ start: 0x1900, end: 0x1907, statements }), new Set())).toEqual([]);
    });

    it("never anchors code on a NOP pair", () => {
        const statements = [
            code(0x1900, [0xa9, 0x01]),
            code(0x1902, [0xea]),
            code(0x1903, [0xea]),
            code(0x1904, [0xa2, 0x02]),
            code(0x1906, [0xa0, 0x03]),
        ];
        const found = candidates(region({ start: 0x1900, end: 0x1908, statements }), new Set());
        expect(found.map(({ at }) => at)).toEqual([0x1903, 0x1904]);
    });

    it("never anchors on fewer than four different bytes, or bytes found twice in the region", () => {
        const plain = [data(0x1900, [0, 0, 0, 0, 1, 1, 1, 1])];
        expect(candidates(region({ start: 0x1900, end: 0x1908, statements: plain }), new Set())).toEqual([]);
        const repeating = [data(0x1900, [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4])];
        expect(candidates(region({ start: 0x1900, end: 0x1910, statements: repeating }), new Set())).toEqual([]);
    });

    it("never covers a blocked byte", () => {
        const statements = routine(0x1900, 2);
        expect(candidates(region({ start: 0x1900, end: 0x190a, statements }), new Set(range(0x1900, 0x190a)))).toEqual(
            [],
        );
    });
});

describe("chooseAnchors", () => {
    const statements = routine(0x1900, 0x60);
    const labels = [{ address: 0x1932, name: "entry" }];

    it("spreads one per bytesPerAnchor over the region, preferring a label", () => {
        const { anchors, errors } = chooseAnchors(
            region({ start: 0x1900, end: 0x1b00, statements, labels }),
            [],
            [],
            Spread,
        );
        expect(errors).toEqual([]);
        expect(anchors.map(({ at }) => at)).toEqual([0x1932, 0x1a01]);
    });

    it("adds an anchor where another program's image of its addresses differs", () => {
        const other = new Map(range(0x1a50, 0x1a60).map((address) => [address, 0]));
        const { anchors, reasons } = chooseAnchors(
            region({ start: 0x1900, end: 0x1b00, statements, labels }),
            [],
            [{ name: "other:main", memory: other, program: true }],
            Spread,
        );
        expect(anchors.some(({ at }) => at >= 0x1a50 - 6 && at < 0x1a60)).toBe(true);
        expect(reasons).toHaveLength(1);
    });

    it("doesn't mind data that differs elsewhere, but fails when an image holds every anchor and nothing tells them apart", () => {
        const differsElsewhere = new Map([[0x1a50, 0]]);
        expect(
            chooseAnchors(
                region({ start: 0x1900, end: 0x1b00, statements }),
                [],
                [{ name: "file DATA", memory: differsElsewhere, program: false }],
                Spread,
            ).reasons,
        ).toEqual([]);
        const small = routine(0x1900, 2);
        const lookalike = new Map([...region({ start: 0x1900, end: 0x190a, statements: small }).memory]);
        lookalike.set(0x1909, 0x99);
        const { errors } = chooseAnchors(
            region({ start: 0x1900, end: 0x190a, statements: small }),
            [],
            [{ name: "file LOOKALIKE", memory: lookalike, program: false }],
            Spread,
        );
        expect(errors).toEqual(["test/main: its anchors all match file LOOKALIKE"]);
    });

    it("notes another program that differs only where no anchor can sit", () => {
        const zeros = data(0x190a, [0, 0, 0, 0, 0, 0, 0, 0]);
        const other = new Map([
            [0x1910, 0],
            [0x1911, 7],
        ]);
        const { notes, errors } = chooseAnchors(
            region({ start: 0x1900, end: 0x1912, statements: [...routine(0x1900, 2), zeros] }),
            [],
            [{ name: "other:main", memory: other, program: true }],
            Spread,
        );
        expect(errors).toEqual([]);
        expect(notes).toEqual(["test/main: no anchor where other:main differs"]);
    });

    it("fails a region with nothing to anchor on", () => {
        const { anchors, errors } = chooseAnchors(
            region({ start: 0x1900, end: 0x1904, statements: [data(0x1900, [0, 0, 0, 0])] }),
            [],
            [],
            Spread,
        );
        expect(anchors).toEqual([]);
        expect(errors).toEqual(["test/main: nothing to anchor on"]);
    });
});
