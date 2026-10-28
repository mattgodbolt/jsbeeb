import { describe, it, expect } from "vitest";

import { IbmDiscFormat } from "../../src/disc-format.js";

describe("IBM disc format tests", function () {
    it.each([
        [false, 0xb1e4],
        [true, 0x9d39],
    ])("calculates crcs with MFM %s", (isMfm, expected) => {
        let crc = IbmDiscFormat.crcInit(isMfm);
        for (const byte of [0x12, 0x34, 0x56, 0x70]) crc = IbmDiscFormat.crcAddByte(crc, byte);
        expect(crc).toBe(expected);
    });

    it.each([
        [0xff, 0x00, 0x88888888],
        [0xff, 0xff, 0xaaaaaaaa],
        [0xc7, 0xfe, 0xaa222aa8],
        [0x00, 0x00, 0x00000000],
    ])("converts FM clocks %i and data %i to and from pulses", (clocks, data, pulses) => {
        expect(IbmDiscFormat.fmTo2usPulses(clocks, data)).toBe(pulses);
        expect(IbmDiscFormat._2usPulsesToFm(pulses)).toEqual({ clocks, data, iffyPulses: false });
    });

    it("flags FM pulses off the bit cells as iffy", () => {
        expect(IbmDiscFormat._2usPulsesToFm(0xaa222aa8 | 0x05)).toEqual({
            clocks: 0xc7,
            data: 0xfe,
            iffyPulses: true,
        });
    });

    it.each([
        [false, 0x00, false, 0xaaaa],
        [true, 0x00, false, 0x2aaa],
        [false, 0xff, true, 0x5555],
        [true, 0xff, true, 0x5555],
        [false, 0x37, true, 0xa515],
        [true, 0x37, true, 0x2515],
    ])("converts MFM after a %s bit, data %i to and from pulses", (previousBit, data, lastBit, pulses) => {
        expect(IbmDiscFormat.mfmTo2usPulses(previousBit, data)).toEqual({ lastBit, pulses });
        expect(IbmDiscFormat._2usPulsesToMfm(pulses)).toBe(data);
    });

    it.each([
        [true, [4.0, 5.51, 6.0, 6.49, 8.0], [0.0, 3.49, 4.51, 7.49, 8.51]],
        [false, [4.0, 8.0], [0.0, 3.49, 4.51, 5.51, 6.0, 6.49, 7.49, 8.51]],
    ])("checks gaps between pulses with MFM %s", (isMfm, good, bad) => {
        for (const gap of good) expect(IbmDiscFormat.checkPulse(gap, isMfm), `${gap}`).toBe(true);
        for (const gap of bad) expect(IbmDiscFormat.checkPulse(gap, isMfm), `${gap}`).toBe(false);
    });
});
