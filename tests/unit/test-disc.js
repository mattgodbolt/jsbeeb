import { describe, it } from "mocha";
import assert from "assert";

import { IbmDiscFormat } from "../../disc.js";

describe("IBM disc format tests", function () {
    it("calculates FM crcs", () => {
        let crc = IbmDiscFormat.crcInit(false);
        crc = IbmDiscFormat.crcAddByte(crc, 0x12);
        crc = IbmDiscFormat.crcAddByte(crc, 0x34);
        crc = IbmDiscFormat.crcAddByte(crc, 0x56);
        crc = IbmDiscFormat.crcAddByte(crc, 0x70);
        assert.equal(crc, 0xb1e4);
    });
    it("calculates MFM crcs", () => {
        let crc = IbmDiscFormat.crcInit(true);
        crc = IbmDiscFormat.crcAddByte(crc, 0x12);
        crc = IbmDiscFormat.crcAddByte(crc, 0x34);
        crc = IbmDiscFormat.crcAddByte(crc, 0x56);
        crc = IbmDiscFormat.crcAddByte(crc, 0x70);
        assert.equal(crc, 0x9d39);
    });
    it("converts to FM pulses", () => {
        assert.equal(IbmDiscFormat.fmTo2usPulses(0xff, 0x00), 0x44444444);
        assert.equal(IbmDiscFormat.fmTo2usPulses(0xff, 0xff), 0x55555555);
        assert.equal(IbmDiscFormat.fmTo2usPulses(0xc7, 0xfe), 0x55111554);
    });
    it("converts from FM pulses", () => {
        // TODO either fix these or understand why beebjit doesn't use same bit posn for bits.
        const deliberateFudge = 1;
        assert.deepEqual(IbmDiscFormat._2usPulsesToFm(0x44444444 << deliberateFudge), {
            clocks: 0xff,
            data: 0x00,
            iffyPulses: false,
        });
        assert.deepEqual(IbmDiscFormat._2usPulsesToFm(0x55555555 << deliberateFudge), {
            clocks: 0xff,
            data: 0xff,
            iffyPulses: false,
        });
        assert.deepEqual(IbmDiscFormat._2usPulsesToFm(0x55111554 << deliberateFudge), {
            clocks: 0xc7,
            data: 0xfe,
            iffyPulses: false,
        });
        assert.deepEqual(IbmDiscFormat._2usPulsesToFm((0x55111554 << deliberateFudge) | 0x05), {
            clocks: 0xc7,
            data: 0xfe,
            iffyPulses: true,
        });
    });
    it("converts to MFM pulses", () => {
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(false, 0x00), { lastBit: false, pulses: 0xaaaa });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(true, 0x00), { lastBit: false, pulses: 0x2aaa });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(false, 0xff), { lastBit: true, pulses: 0x5555 });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(true, 0xff), { lastBit: true, pulses: 0x5555 });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(false, 0x37), { lastBit: true, pulses: 0xa515 });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(true, 0x37), { lastBit: true, pulses: 0x2515 });
    });
    it("Converts from MFM pulses", () => {
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0xaaaa), 0);
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0x2aaa), 0);
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0x5555), 0xff);
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0xa515), 0x37);
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0x2515), 0x37);
    });
    it("checks gaps between MFM pulses", () => {
        assert(!IbmDiscFormat.checkPulse(0.0, true));
        assert(!IbmDiscFormat.checkPulse(3.49, true));
        assert(!IbmDiscFormat.checkPulse(4.51, true));
        assert(!IbmDiscFormat.checkPulse(7.49, true));
        assert(!IbmDiscFormat.checkPulse(8.51, true));

        assert(IbmDiscFormat.checkPulse(4.0, true));
        assert(IbmDiscFormat.checkPulse(5.51, true));
        assert(IbmDiscFormat.checkPulse(6.0, true));
        assert(IbmDiscFormat.checkPulse(6.49, true));
        assert(IbmDiscFormat.checkPulse(8.0, true));
    });
    it("checks gaps between FM pulses", () => {
        assert(!IbmDiscFormat.checkPulse(0.0, false));
        assert(!IbmDiscFormat.checkPulse(3.49, false));
        assert(!IbmDiscFormat.checkPulse(4.51, false));
        assert(!IbmDiscFormat.checkPulse(5.51, false));
        assert(!IbmDiscFormat.checkPulse(6.0, false));
        assert(!IbmDiscFormat.checkPulse(6.49, false));
        assert(!IbmDiscFormat.checkPulse(7.49, false));
        assert(!IbmDiscFormat.checkPulse(8.51, false));

        assert(IbmDiscFormat.checkPulse(4.0, false));
        assert(IbmDiscFormat.checkPulse(8.0, false));
    });
});
