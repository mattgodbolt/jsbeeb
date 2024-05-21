// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit

export class IbmDiscFormat {
    static get bytesPerTrack() {
        return 3125;
    }

    static get tracksPerDisc() {
        return 84;
    }

    static get markClockPattern() {
        return 0xc7;
    }

    static get idMarkDataPattern() {
        return 0xfe;
    }

    static get dataMarkDataPattern() {
        return 0xfb;
    }

    static get deletedDataMarkDataPattern() {
        return 0xf8;
    }

    static get mfmA1Sync() {
        return 0x4489;
    }

    static get mfmC2Sync() {
        return 0x5224;
    }

    static get stdSync00s() {
        return 6;
    }

    static get stdGap1FFs() {
        return 16;
    }

    static get stdGap2FFs() {
        return 11;
    }

    static get std10SectorGap3FFs() {
        return 21;
    }

    static crcInit(is_mfm) {
        // MFM starts with 3x 0xA1 sync bytes added.
        return is_mfm ? 0xcdb4 : 0xffff;
    }

    static crcAddByte(crc, byte) {
        for (let i = 0; i < 8; ++i) {
            const bit = byte & 0x80;
            const bitTest = (crc & 0x8000) ^ (bit << 8);
            crc = (crc << 1) & 0xffff;
            if (bitTest) crc ^= 0x1021;
            byte <<= 1;
        }
        return crc;
    }

    static fmTo2usPulses(clocks, data) {
        let ret = 0;
        for (let i = 0; i < 8; ++i) {
            ret <<= 4;
            if (clocks & 0x80) ret |= 0x04;
            if (data & 0x80) ret |= 0x01;
            clocks = (clocks << 1) & 0xff;
            data = (data << 1) & 0xff;
        }
        return ret;
    }

    static _2usPulsesToFm(pulses) {
        let clocks = 0;
        let data = 0;
        let iffyPulses = false;
        for (let i = 0; i < 8; ++i) {
            clocks <<= 1;
            data <<= 1;
            if (pulses & 0x80000000) clocks |= 0x01;
            if (pulses & 0x20000000) data |= 0x01;
            // Any pulses off the 2us clock are suspicious FM data.
            if (pulses & 0x50000000) iffyPulses = true;
            pulses = (pulses << 4) & 0xffffffff;
        }
        return { clocks, data, iffyPulses };
    }

    static mfmTo2usPulses(lastBit, data) {
        let pulses = 0;
        for (let i = 0; i < 8; ++i) {
            const bit = !!(data & 0x80);
            pulses = (pulses << 2) & 0xffff;
            data <<= 1;
            if (bit) pulses |= 0x01;
            else if (!lastBit) pulses |= 0x02;
            lastBit = bit;
        }
        return { lastBit, pulses };
    }

    static _2usPulsesToMfm(pulses) {
        let byte = 0;
        for (let i = 0; i < 8; ++i) {
            byte <<= 1;
            if ((pulses & 0xc000) === 0x4000) byte |= 1;
            pulses = (pulses << 2) & 0xffff;
        }
        return byte;
    }

    static checkPulse(pulseUs, isMfm) {
        if (pulseUs < 3.5 || pulseUs > 8.5) return false;
        if (isMfm && pulseUs > 5.5 && pulseUs < 6.5) return true;
        return !(pulseUs > 4.5 && pulseUs < 7.5);
    }
}
