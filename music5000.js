"use strict";

// Code ported from Beebem (C to .js) by Jason Robson
const AUDIO_BUFFER_SIZE = 256;

const RAM_SIZE = 2048;
const WAVE_TABLE_SIZE = 128;
const WAVE_TABLES = 14;
const NUM_CHANNELS = 16;
const CHANNEL_REG_OFFSET = WAVE_TABLES * WAVE_TABLE_SIZE;
const CHANNEL_ROW_SIZE = 128;

// Control register bits
const CTRL_STEREO_POS = 0xf;
const CTRL_INVERT_WAVE = 1 << 4;
const CTRL_MODULATE_ADJ = 1 << 5;

// Data bits
const DATA_SIGN = 1 << 7;
const DATA_VALUE = 0x7f;
const FREQ_DISABLE = 1 << 0;
const NOT_FREQ_DISABLE = 0xfe;

// Channel register sets
const REG_SET_NORMAL = 0;
const REG_SET_ALT = 1;

export class Music5000 {
    constructor(onBuffer) {
        this._onBufferMusic5000 = onBuffer;

        this.waveRam = new Uint8Array(RAM_SIZE);
        this.phaseRam = new Uint32Array(NUM_CHANNELS);
        this.cycleCount = 0;
        this.curCh = 0;
        this.activeRegSet = REG_SET_NORMAL;
        this.sampleLeft = 0;
        this.sampleRight = 0;

        this.chordBase = [0, 8.25, 24.75, 57.75, 123.75, 255.75, 519.75, 1047.75];
        this.stepInc = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0];

        this.stereoLeft = [0, 0, 0, 0, 0, 0, 0, 0, 100, 100, 100, 83, 67, 50, 33, 17];
        this.stereoRight = [100, 100, 100, 100, 100, 100, 100, 100, 0, 0, 0, 17, 33, 50, 67, 83];

        this.D2ATable = new Uint16Array(128);

        this.sampleBuffer = new Float64Array(AUDIO_BUFFER_SIZE);
        this.position = 0;

        // Helper functions to access the register set and wavetable
        this.cReg_freqLow = function (channel, regSet) {
            return this.waveRam[CHANNEL_REG_OFFSET + regSet * CHANNEL_ROW_SIZE + 0 * NUM_CHANNELS + channel];
        };
        this.cReg_freqMedium = function (channel, regSet) {
            return this.waveRam[CHANNEL_REG_OFFSET + regSet * CHANNEL_ROW_SIZE + 1 * NUM_CHANNELS + channel];
        };
        this.cReg_freqHigh = function (channel, regSet) {
            return this.waveRam[CHANNEL_REG_OFFSET + regSet * CHANNEL_ROW_SIZE + 2 * NUM_CHANNELS + channel];
        };
        this.cReg_waveformReg = function (channel, regSet) {
            return this.waveRam[CHANNEL_REG_OFFSET + regSet * CHANNEL_ROW_SIZE + 5 * NUM_CHANNELS + channel];
        };
        this.cReg_amplitudeReg = function (channel, regSet) {
            return this.waveRam[CHANNEL_REG_OFFSET + regSet * CHANNEL_ROW_SIZE + 6 * NUM_CHANNELS + channel];
        };
        this.cReg_controlReg = function (channel, regSet) {
            return this.waveRam[CHANNEL_REG_OFFSET + regSet * CHANNEL_ROW_SIZE + 7 * NUM_CHANNELS + channel];
        };

        this.waveTableVal = function (table, b) {
            return this.waveRam[table * WAVE_TABLE_SIZE + b];
        };
    }

    reset(hard) {
        if (hard) {
            console.log("Music 5000: initialisation");

            // Build the D2A table
            let i = 0;
            for (let chord = 0; chord < 8; chord++) {
                let val = this.chordBase[chord];
                for (let step = 0; step < 16; step++) {
                    this.D2ATable[i] = Math.floor(val * 4); // Multiply up to get an integer
                    val += this.stepInc[chord];
                    i++;
                }
            }
        }

        // Clear RAM
        for (let w = 0; w < RAM_SIZE; w++) {
            this.waveRam[w] = 0;
        }

        for (let p = 0; p < NUM_CHANNELS; p++) {
            this.phaseRam[p] = 0;
        }
    }

    read(page, addr) {
        // Bit0 unused
        const offset = ((page & 0x0e) << 7) + addr;
        return this.waveRam[offset];
    }

    write(page, addr, value) {
        // Bit0 unused
        const offset = ((page & 0x0e) << 7) + (addr & 0xff);
        this.waveRam[offset] = value;
    }

    polltime(cycles) {
        let c4d,
            freq,
            offset,
            wavetable,
            amplitude,
            control,
            data,
            sign,
            pos = 0 >>> 0;

        // Convert 2MHz 6502 cycles to 6MHz Music5000 cycles
        this.cycleCount += cycles * 3;

        // Need 8 cycles to update a channel
        while (this.cycleCount >= 8) {
            // Update phase for active register set
            if (this.cReg_freqLow(this.curCh, this.activeRegSet) & FREQ_DISABLE) {
                this.phaseRam[this.curCh] = 0;
                c4d = 0;
            } else {
                freq =
                    (this.cReg_freqHigh(this.curCh, this.activeRegSet) << 16) +
                    (this.cReg_freqMedium(this.curCh, this.activeRegSet) << 8) +
                    (this.cReg_freqLow(this.curCh, this.activeRegSet) & NOT_FREQ_DISABLE);
                this.phaseRam[this.curCh] += freq;
                c4d = this.phaseRam[this.curCh] & (1 << 24);
                this.phaseRam[this.curCh] &= 0xffffff;
            }

            // Pull wave sample out for the active register set
            offset = (this.phaseRam[this.curCh] >> 17) & 0x7f;
            wavetable = this.cReg_waveformReg(this.curCh, this.activeRegSet) >> 4;
            data = this.waveTableVal(wavetable, offset);
            amplitude = this.cReg_amplitudeReg(this.curCh, this.activeRegSet);
            control = this.cReg_controlReg(this.curCh, this.activeRegSet);
            sign = data & DATA_SIGN;
            data &= DATA_VALUE;

            // Modulate the next channel?
            if (control & CTRL_MODULATE_ADJ && (sign || c4d)) this.activeRegSet = REG_SET_ALT;
            else this.activeRegSet = REG_SET_NORMAL;

            if (amplitude > 0x80) amplitude = 0x80;
            data = (data * amplitude) / 0x80;

            let sample = this.D2ATable[parseInt(data)];
            if (control & CTRL_INVERT_WAVE) sign ^= DATA_SIGN;
            if (sign) sample = -sample;

            // Stereo
            pos = control & CTRL_STEREO_POS;
            this.sampleLeft += (sample * this.stereoLeft[pos]) / 100;
            this.sampleRight += (sample * this.stereoRight[pos]) / 100;

            this.curCh++;
            if (this.curCh === NUM_CHANNELS) {
                this.curCh = 0;
                this.activeRegSet = REG_SET_NORMAL;

                // Range check
                if (this.sampleLeft < -32768) this.sampleLeft = -32768;
                else if (this.sampleLeft > 32767) this.sampleLeft = 32767;

                if (this.sampleRight < -32768) this.sampleRight = -32768;
                else if (this.sampleRight > 32767) this.sampleRight = 32767;

                this.sampleBuffer[this.position++] = this.sampleLeft;
                this.sampleBuffer[this.position++] = this.sampleRight;

                if (this.position === AUDIO_BUFFER_SIZE) {
                    this._onBufferMusic5000(this.sampleBuffer);
                    this.position = 0;
                }

                this.sampleLeft = 0;
                this.sampleRight = 0;
            }

            this.cycleCount -= 8;
        }
    }
}

export class FakeMusic5000 {
    constructor() {
        this.reset = function () {};
        this.polltime = function () {};
        this.read = function () {
            return 0;
        };
        this.write = function () {};
    }
}
