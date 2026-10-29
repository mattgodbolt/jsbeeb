import { describe, expect, it } from "vitest";

import { compileCondition } from "../../src/conditions.js";

describe("compileCondition", () => {
    const memory = new Map([
        [0x70, 0x05],
        [0x71, 0x80],
    ]);
    const cpu = {
        a: 0x0d,
        x: 0x01,
        y: 0xff,
        s: 0xf0,
        pc: 0x2000,
        p: { asByte: () => 0b1000_0011 },
        peekmem: (address) => memory.get(address) ?? 0,
    };
    const holds = (text) => compileCondition(text)(cpu, 0x41, 0x40) !== 0;

    it.each([
        ["A == 13", true],
        ["A = &0D", true],
        ["A = $0d", true],
        ["a = 0xD", true],
        ["A != 13", false],
        ["A <> 13", false],
        ["A == 13 && X == 1", true],
        ["A = 13 AND X = 2", false],
        ["A = 14 || Y = 255", true],
        ["A = 14 OR Y = 255", true],
        ["!(A = 13)", false],
        ["NOT (A = 14)", true],
        ["A & 8", true],
        ["A AND 2", false],
        ["A & &08", true],
        ["(A | 2) = 15", true],
        ["(A EOR 1) = 12", true],
        ["(A ^ 1) = 12", true],
        ["PC >= &2000 && PC < &3000", true],
        ["S = &F0", true],
        ["P = &83", true],
        ["C && Z && N && !V && !I && !D", true],
        ["C = 1", true],
        ["?&70 = 5", true],
        ["?(&70 + X) = &80", true],
        ["?&70 + 1 = 6", true],
        ["value != old", true],
        ["VALUE = &41 AND OLD = &40", true],
        ["-1 + X = 0", true],
        ["A < X", false],
        ["A > X", true],
        ["A <= 13", true],
    ])("%s holds: %s", (text, expected) => {
        expect(holds(text)).toBe(expected);
    });

    it.each([
        ["", "expected a value at column 1"],
        ["A =", "expected a value at column 4"],
        ["A = 1)", 'unexpected ")" at column 6'],
        ["(A = 1", 'expected ")" at column 7'],
        ["Q = 1", 'unknown name "Q" at column 1'],
        ["A # 1", 'unexpected "#" at column 3'],
        ["A 1", 'unexpected "1" at column 3'],
    ])("refuses %j", (text, message) => {
        expect(() => compileCondition(text)).toThrow(`Bad condition "${text}": ${message}`);
    });
});
