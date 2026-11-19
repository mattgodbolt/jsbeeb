import { describe, expect, it } from "vitest";

import { formatInf, parseInf } from "../../src/vdfs-inf.js";

describe("VDFS .inf files", () => {
    it.each([
        ["$.MENU  FFFF1900 FFFF8023 00000A00\n", { load: 0xffff1900, exec: 0xffff8023, locked: false }],
        ["MENU 1900 8023", { load: 0x1900, exec: 0x8023, locked: false }],
        ["$.MENU  1900 8023 A00 L", { load: 0x1900, exec: 0x8023, locked: true }],
        ["$.MENU  1900 8023 A00 Locked", { load: 0x1900, exec: 0x8023, locked: true }],
        ["$.MENU  1900 8023 A00 08", { load: 0x1900, exec: 0x8023, locked: true }],
        ["$.MENU  1900 8023 A00 CRC=1234", { load: 0x1900, exec: 0x8023, locked: false }],
        ["$.MENU", { load: 0, exec: 0, locked: false }],
        ["", { load: 0, exec: 0, locked: false }],
        ["$.MENU  zzzz yyyy", { load: 0, exec: 0, locked: false }],
    ])("reads %j", (text, expected) => {
        expect(parseInf(text)).toEqual(expected);
    });

    it("writes what it reads", () => {
        const line = formatInf("MENU", { load: 0xffff1900, exec: 0xffff8023, locked: true, length: 0xa00 });
        expect(line).toBe("$.MENU  FFFF1900 FFFF8023 00000A00 L\n");
        expect(parseInf(line)).toEqual({ load: 0xffff1900, exec: 0xffff8023, locked: true });
    });
});
