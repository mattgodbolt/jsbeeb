"use strict";
import * as utils from "./utils.js";

export function SoundChip(sampleRate) {
    const cpuFreq = 1 / (2 * 1000 * 1000); // TODO hacky here
    // 4MHz input signal. Internal divide-by-8
    const soundchipFreq = 4000000.0 / 8;
    // Square wave changes every time a counter hits zero. Thus a full wave
    // needs to be 2x counter zeros.
    const waveDecrementPerSecond = soundchipFreq / 2;
    // Each sample in the buffer represents (1/sampleRate) time, so each time
    // we generate a sample, we need to decrement the counters by this amount:
    const sampleDecrement = waveDecrementPerSecond / sampleRate;
    // How many samples are generated per CPU cycle.
    const samplesPerCycle = sampleRate * cpuFreq;
    const minCyclesWELow = 14; // Somewhat empirically derived; Repton 2 has only 14 cycles between WE low and WE high (@0x2caa)

    const register = [0, 0, 0, 0];
    this.registers = register; // for debug
    const counter = [0, 0, 0, 0];
    const outputBit = [false, false, false, false];
    const volume = [0, 0, 0, 0];
    this.volume = volume; // for debug
    const generators = [null, null, null, null, null];

    const volumeTable = [];
    let f = 1.0;
    for (let i = 0; i < 16; ++i) {
        volumeTable[i] = f / generators.length; // Bakes in the per channel volume
        f *= Math.pow(10, -0.1);
    }
    volumeTable[15] = 0;

    const sineTableSize = 8192;
    const sineTable = [];
    for (let i = 0; i < sineTableSize; ++i) {
        sineTable[i] = Math.sin((2 * Math.PI * i) / sineTableSize) / generators.length;
    }
    let sineStep = 0;
    let sineOn = false;
    let sineTime = 0;

    function sineChannel(channel, out, offset, length) {
        if (!sineOn) {
            return;
        }
        for (let i = 0; i < length; ++i) {
            out[i + offset] += sineTable[sineTime & (sineTableSize - 1)];
            sineTime += sineStep;
        }
        while (sineTime > sineTableSize) sineTime -= sineTableSize;
    }

    this.toneGenerator = {
        mute: function () {
            catchUp();
            sineOn = false;
        },
        tone: function (freq) {
            catchUp();
            sineOn = true;
            sineStep = (freq / sampleRate) * sineTableSize;
        },
    };

    function toneChannel(channel, out, offset, length) {
        let reg = register[channel];
        const vol = volume[channel];
        if (reg === 0) reg = 1024;
        for (let i = 0; i < length; ++i) {
            counter[channel] -= sampleDecrement;
            if (counter[channel] < 0) {
                counter[channel] += reg;
                if (counter[channel] < 0) counter[channel] = 0;
                outputBit[channel] = !outputBit[channel];
            }
            out[i + offset] += outputBit[channel] * vol;
        }
    }

    let lfsr = 0;

    function shiftLfsrWhiteNoise() {
        const bit = (lfsr & 1) ^ ((lfsr & (1 << 1)) >>> 1);
        lfsr = (lfsr >>> 1) | (bit << 14);
    }

    function shiftLfsrPeriodicNoise() {
        lfsr >>= 1;
        if (lfsr === 0) lfsr = 1 << 14;
    }

    let shiftLfsr = shiftLfsrWhiteNoise;

    function noisePoked() {
        shiftLfsr = register[3] & 4 ? shiftLfsrWhiteNoise : shiftLfsrPeriodicNoise;
        lfsr = 1 << 14;
    }

    function addFor(channel) {
        channel = channel | 0;
        switch (register[channel] & 3) {
            case 0:
                return 0x10;
            case 1:
                return 0x20;
            case 2:
                return 0x40;
            case 3:
                return register[channel - 1];
        }
    }

    function noiseChannel(channel, out, offset, length) {
        const add = addFor(channel),
            vol = volume[channel];
        for (let i = 0; i < length; ++i) {
            counter[channel] -= sampleDecrement;
            if (counter[channel] < 0) {
                counter[channel] += add;
                if (counter[channel] < 0) counter[channel] = 0;
                outputBit[channel] = !outputBit[channel];
                if (outputBit[channel]) shiftLfsr();
            }
            out[i + offset] += (lfsr & 1) * vol;
        }
    }

    this.debugPokeAll = (c0, v0, c1, v1, c2, v2, c3, v3) => {
        catchUp();
        this.registers[0] = c0 & 0xffffff;
        this.registers[1] = c1 & 0xffffff;
        this.registers[2] = c2 & 0xffffff;
        this.registers[3] = c3 & 0xffffff;
        volume[0] = volumeTable[v0];
        volume[1] = volumeTable[v1];
        volume[2] = volumeTable[v2];
        volume[3] = volumeTable[v3];
        noisePoked();
    };

    let enabled = true;

    function generate(out, offset, length) {
        offset = offset | 0;
        length = length | 0;
        for (let i = 0; i < length; ++i) {
            out[i + offset] = 0.0;
        }
        if (!enabled) return;
        for (let i = 0; i < generators.length; ++i) {
            generators[i](i, out, offset, length);
        }
    }

    let scheduler = { epoch: 0 };
    let lastRunEpoch = 0;

    function catchUp() {
        const cyclesPending = scheduler.epoch - lastRunEpoch;
        if (cyclesPending > 0) {
            advance(cyclesPending);
        }
        lastRunEpoch = scheduler.epoch;
    }

    let activeTask = null;
    this.setScheduler = function (scheduler_) {
        scheduler = scheduler_;
        lastRunEpoch = scheduler.epoch;
        activeTask = scheduler.newTask(
            function () {
                if (this.active) {
                    poke(this.slowDataBus);
                }
            }.bind(this)
        );
    };

    let residual = 0;
    let position = 0;
    const maxBufferSize = 4096;
    let buffer;
    if (typeof Float64Array !== "undefined") {
        buffer = new Float64Array(maxBufferSize);
    } else {
        buffer = new Float32Array(maxBufferSize);
    }

    function render(out, offset, length) {
        catchUp();
        const fromBuffer = position > length ? length : position;
        for (let i = 0; i < fromBuffer; ++i) {
            out[offset + i] = buffer[i];
        }
        offset += fromBuffer;
        length -= fromBuffer;
        for (let i = fromBuffer; i < position; ++i) {
            buffer[i - fromBuffer] = buffer[i];
        }
        position -= fromBuffer;
        if (length !== 0) {
            generate(out, offset, length);
        }
    }

    function advance(time) {
        const num = time * samplesPerCycle + residual;
        let rounded = num | 0;
        residual = num - rounded;
        if (position + rounded >= maxBufferSize) {
            rounded = maxBufferSize - position;
        }
        if (rounded === 0) return;
        generate(buffer, position, rounded);
        position += rounded;
    }

    let latchedRegister = 0;

    function poke(value) {
        catchUp();

        let command;
        if (value & 0x80) {
            latchedRegister = value & 0x70;
            command = value & 0xf0;
        } else {
            command = latchedRegister;
        }
        const channel = (command >> 5) & 0x03;

        if (command & 0x10) {
            // Volume setting
            const newVolume = value & 0x0f;
            volume[channel] = volumeTable[newVolume];
        } else if (channel === 3) {
            // For noise channel we always update the bottom bits.
            register[channel] = value & 0x0f;
            noisePoked();
        } else if (command & 0x80) {
            // Low period bits.
            register[channel] = (register[channel] & ~0x0f) | (value & 0x0f);
        } else {
            // High period bits.
            register[channel] = (register[channel] & 0x0f) | ((value & 0x3f) << 4);
        }
    }

    for (let i = 0; i < 3; ++i) {
        generators[i] = toneChannel;
    }
    generators[3] = noiseChannel;
    generators[4] = sineChannel;

    this.render = render;
    this.active = false;
    this.slowDataBus = 0;
    this.updateSlowDataBus = function (slowDataBus, active) {
        this.slowDataBus = slowDataBus;
        this.active = active;
        // TODO: this probably isn't modeled correctly. Currently the
        // sound chip "notices" a new data bus value some fixed number of
        // cycles after WE (write enable) is triggered.
        // In reality, the sound chip likely pulls data off the bus at a
        // fixed point in its cycle, iff WE is active.
        if (active) {
            activeTask.ensureScheduled(true, minCyclesWELow);
        }
    };
    this.reset = function (hard) {
        if (!hard) return;
        for (let i = 0; i < 4; ++i) {
            counter[i] = 0;
            register[i] = 0;
            volume[i] = 0; // ideally this would be volumeTable[0] to get the "boo" of "boo...beep".  But startup issues make the "boo" all clicky.
        }
        noisePoked();
        advance(100000);
        this.setScheduler(scheduler);
    };
    this.enable = function (e) {
        enabled = e;
    };
    this.mute = function () {
        enabled = false;
    };
    this.unmute = function () {
        enabled = true;
    };
}

export function FakeSoundChip() {
    this.reset =
        this.enable =
        this.mute =
        this.unmute =
        this.render =
        this.updateSlowDataBus =
        this.setScheduler =
            utils.noop;
    this.toneGenerator = this;
}
