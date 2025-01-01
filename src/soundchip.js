const volumeTable = new Float32Array(16);
(() => {
    let f = 1.0;
    for (let i = 0; i < 15; ++i) {
        volumeTable[i] = f / 4; // Bakes in the per channel volume
        f *= Math.pow(10, -0.1);
    }
    volumeTable[15] = 0;
})();

function makeSineTable(attenuation) {
    const sineTable = new Float32Array(8192);
    for (let i = 0; i < sineTable.length; ++i) {
        sineTable[i] = Math.sin((2 * Math.PI * i) / sineTable.length) * attenuation;
    }
    return sineTable;
}

export class SoundChip {
    constructor(onBuffer) {
        this._onBuffer = onBuffer;
        // 4MHz input signal. Internal divide-by-8
        this.soundchipFreq = 4000000.0 / 8;
        const sampleRate = this.soundchipFreq;
        // Square wave changes every time a counter hits zero: A full wave needs to be 2x counter zeros.
        this.waveDecrementPerSecond = this.soundchipFreq / 2;
        // Each sample in the buffer represents (1/sampleRate) time, so each time
        // we generate a sample, we need to decrement the counters by this amount:
        this.sampleDecrement = this.waveDecrementPerSecond / sampleRate;
        // How many samples are generated per CPU cycle.
        this.samplesPerCycle = sampleRate / 2000000;
        this.minCyclesWELow = 14; // Somewhat empirically derived; Repton 2 has only 14 cycles between WE low and WE high (@0x2caa)

        this.registers = new Uint16Array(4);
        this.counter = new Float32Array(4);
        this.outputBit = [false, false, false, false];
        this.volume = new Float32Array(4);
        this.generators = [
            this.toneChannel.bind(this),
            this.toneChannel.bind(this),
            this.toneChannel.bind(this),
            this.noiseChannel.bind(this),
            this.sineChannel.bind(this),
        ];

        this.sineTable = makeSineTable(1 / this.generators.length);
        this.sineStep = 0;
        this.sineOn = false;
        this.sineTime = 0;

        this.lfsr = 0;
        this.shiftLfsr = this.shiftLfsrWhiteNoise.bind(this);

        this.enabled = true;
        this.scheduler = { epoch: 0 };
        this.lastRunEpoch = 0;
        this.activeTask = null;

        this.residual = 0;
        this.position = 0;
        this.buffer = new Float32Array(512);

        this.latchedRegister = 0;
        this.slowDataBus = 0;
        this.active = false;

        this.toneGenerator = {
            mute: () => {
                this.catchUp();
                this.sineOn = false;
            },
            tone: (freq) => {
                this.catchUp();
                this.sineOn = true;
                this.sineStep = (freq / sampleRate) * this.sineTable.length;
            },
        };
    }

    sineChannel(channel, out, offset, length) {
        if (!this.sineOn) return;

        for (let i = 0; i < length; ++i) {
            out[i + offset] += this.sineTable[this.sineTime & (this.sineTable.length - 1)];
            this.sineTime += this.sineStep;
        }
        while (this.sineTime > this.sineTable.length) this.sineTime -= this.sineTable.length;
    }

    _doChannelStep(channel, addAmount) {
        const newValue = this.counter[channel] - this.sampleDecrement;
        if (newValue < 0) {
            this.counter[channel] = Math.max(0, newValue + addAmount);
            this.outputBit[channel] = !this.outputBit[channel];
            return this.outputBit[channel];
        } else {
            this.counter[channel] = newValue;
            return false;
        }
    }

    toneChannel(channel, out, offset, length) {
        const reg = this.registers[channel] === 0 ? 1024 : this.registers[channel];
        const vol = this.volume[channel];
        for (let i = 0; i < length; ++i) {
            this._doChannelStep(channel, reg);
            out[i + offset] += this.outputBit[channel] * vol;
        }
    }

    shiftLfsrWhiteNoise() {
        const bit = (this.lfsr & 1) ^ ((this.lfsr & (1 << 1)) >>> 1);
        this.lfsr = (this.lfsr >>> 1) | (bit << 14);
    }

    shiftLfsrPeriodicNoise() {
        this.lfsr >>= 1;
        if (this.lfsr === 0) this.lfsr = 1 << 14;
    }

    noisePoked() {
        this.shiftLfsr =
            this.registers[3] & 4 ? this.shiftLfsrWhiteNoise.bind(this) : this.shiftLfsrPeriodicNoise.bind(this);
        this.lfsr = 1 << 14;
    }

    addFor(channel) {
        channel = channel | 0;
        switch (this.registers[channel] & 3) {
            case 0:
                return 0x10;
            case 1:
                return 0x20;
            case 2:
                return 0x40;
            case 3:
                return this.registers[channel - 1];
        }
    }

    noiseChannel(channel, out, offset, length) {
        const add = this.addFor(channel),
            vol = this.volume[channel];
        for (let i = 0; i < length; ++i) {
            if (this._doChannelStep(channel, add)) this.shiftLfsr();
            out[i + offset] += (this.lfsr & 1) * vol;
        }
    }

    debugPokeAll(c0, v0, c1, v1, c2, v2, c3, v3) {
        this.catchUp();
        this.registers[0] = c0 & 0xffffff;
        this.registers[1] = c1 & 0xffffff;
        this.registers[2] = c2 & 0xffffff;
        this.registers[3] = c3 & 0xffffff;
        this.volume[0] = volumeTable[v0];
        this.volume[1] = volumeTable[v1];
        this.volume[2] = volumeTable[v2];
        this.volume[3] = volumeTable[v3];
        this.noisePoked();
    }

    generate(out, offset, length) {
        offset = offset | 0;
        length = length | 0;
        for (let i = 0; i < length; ++i) {
            out[i + offset] = 0.0;
        }
        if (!this.enabled) return;
        for (let i = 0; i < this.generators.length; ++i) {
            this.generators[i](i, out, offset, length);
        }
    }

    catchUp() {
        const cyclesPending = this.scheduler.epoch - this.lastRunEpoch;
        if (cyclesPending > 0) this.advance(cyclesPending);
        this.lastRunEpoch = this.scheduler.epoch;
    }

    setScheduler(scheduler_) {
        this.scheduler = scheduler_;
        this.lastRunEpoch = this.scheduler.epoch;
        this.activeTask = this.scheduler.newTask(() => {
            if (this.active) this.poke(this.slowDataBus);
        });
    }

    render(out, offset, length) {
        this.catchUp();
        const fromBuffer = this.position > length ? length : this.position;
        for (let i = 0; i < fromBuffer; ++i) {
            out[offset + i] = this.buffer[i];
        }
        offset += fromBuffer;
        length -= fromBuffer;
        for (let i = fromBuffer; i < this.position; ++i) {
            this.buffer[i - fromBuffer] = this.buffer[i];
        }
        this.position -= fromBuffer;
        if (length !== 0) {
            this.generate(out, offset, length);
        }
    }

    advance(cycles) {
        const num = cycles * this.samplesPerCycle + this.residual;
        let rounded = num | 0;
        this.residual = num - rounded;
        const bufferLength = this.buffer.length;
        while (rounded > 0) {
            const leftInBuffer = bufferLength - this.position;
            const numSamplesToGenerate = Math.min(rounded, leftInBuffer);
            this.generate(this.buffer, this.position, numSamplesToGenerate);
            this.position += numSamplesToGenerate;
            rounded -= numSamplesToGenerate;

            if (this.position === bufferLength) {
                this._onBuffer(this.buffer);
                this.buffer = new Float32Array(bufferLength);
                this.position = 0;
            }
        }
    }

    poke(value) {
        this.catchUp();

        let command;
        if (value & 0x80) {
            this.latchedRegister = value & 0x70;
            command = value & 0xf0;
        } else {
            command = this.latchedRegister;
        }
        const channel = (command >> 5) & 0x03;

        if (command & 0x10) {
            // Volume setting
            const newVolume = value & 0x0f;
            this.volume[channel] = volumeTable[newVolume];
        } else if (channel === 3) {
            // For noise channel we always update the bottom bits.
            this.registers[channel] = value & 0x0f;
            this.noisePoked();
        } else if (command & 0x80) {
            // Low period bits.
            this.registers[channel] = (this.registers[channel] & ~0x0f) | (value & 0x0f);
        } else {
            // High period bits.
            this.registers[channel] = (this.registers[channel] & 0x0f) | ((value & 0x3f) << 4);
        }
    }

    updateSlowDataBus(slowDataBus, active) {
        this.slowDataBus = slowDataBus;
        this.active = active;
        // TODO: this probably isn't modeled correctly. Currently the sound chip "notices" a new data bus value some
        // fixed number of cycles after WE (write enable) is triggered. In reality, the sound chip likely pulls data off
        // the bus at a fixed point in its cycle, iff WE is active.
        if (active) {
            this.activeTask.ensureScheduled(true, this.minCyclesWELow);
        }
    }

    reset(hard) {
        if (!hard) return;
        for (let i = 0; i < 4; ++i) {
            this.counter[i] = 0;
            this.registers[i] = 0;
            // Real hardware would be volumeTable[0] but that's really quite loud and surprising...
            this.volume[i] = volumeTable[8];
        }
        this.noisePoked();
        this.lastRunEpoch = this.scheduler.epoch;
    }

    enable(e) {
        this.enabled = e;
    }

    mute() {
        this.enabled = false;
    }

    unmute() {
        this.enabled = true;
    }
}

export class FakeSoundChip {
    reset() {}

    enable() {}

    mute() {}

    unmute() {}

    render() {}

    updateSlowDataBus() {}

    setScheduler() {}

    constructor() {
        this.toneGenerator = {
            mute: () => {},
            tone: () => {},
        };
    }
}
