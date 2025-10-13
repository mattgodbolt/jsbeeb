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
        // samplesPerCycle will be overwritten by setCPUSpeed
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
            this.speakerChannel.bind(this), // Acorn Atom generator
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

        // ATOM
        this.isAtom = false; // set to true for the ATOM
        // this.speakerGenerator with mute and pushbit to push bits to the speaker which
        // will play all the time and play the bits in packets to the speaker
        this.speakerGenerator = {
            mute: () => {
                this.catchUp();
                this.speakerReset();
            },
            pushBit: (bit, cycles, seconds) => {
                this.catchUp();
                this.updateSpeaker(bit, cycles, seconds);
            },
        };

        this.cpuFreq = 1 / 1000000; // 1MHZ atom
        this.speakerBufferSize = 8192;
        this.speakerBuffer = [];
        for (let i = 0; i < this.speakerBufferSize; ++i) {
            this.speakerBuffer[i] = 0.0;
        }
        this.speakerTime = 0;
        this.bufferPos = this.speakerBufferSize >> 1; // start buffer half way through buffer and speakertime at the beginning
        this.lastSecond = 0;
        this.lastMicroCycle = 0;
        this.outstandingCycles = 0;
        this.numSamplesAdded = 0;
    }

    // ATOM
    setCPUSpeed(cpuSpeed) {
        this.cpuFreq = 1 / cpuSpeed;
        this.samplesPerCycle = this.soundchipFreq * this.cpuFreq;
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
            // ATOM
            if (this.isAtom) {
                // no need to generate these channels on ATOM
                // BBC only
                if (i < 4) continue;
            } else {
                // no need to generate this channel on BBC
                // ATOM only
                if (i == 5) continue;
            }
            // NOTE: channel 4 is sine channel which can be used by both
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

        // ATOM
        this.speakerReset();
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

    // ATOM
    // Atom Speaker - pushBit will be called by the CPU via the PPIA to set a 0 to the physical speaker output
    // but the PPIA port A bit is usually set to 1 giving no sound. Only a change in the value causes the speaker to
    // buzz.

    // The 'soundchip' is scheduled to send data to the browser audiohandler at sampleRate.
    // speakerChannel will fill the out buffer with data from the speakerBuffer
    // the speakerbuffer is filled with the data via updateSpeaker

    // so cpu -> ppia -> updatespeaker > speakerbuffer -> speakerchannel -> out

    // ATOM
    speakerReset() {
        this.bitChange = []; // FIFO queue
        this.currentSpeakerBit = 0.0; // most recent bit to be copied into out
    }

    // ATOM
    speakerChannel(channel, out, offset, length) {
        // channel not used
        // out is the buffer to fill (total buffer is no more than 512 samples in size)
        // offset is the position in the out buffer to start filling
        // length is the number of samples to fill

        // this.scheduler.epoch is the number of cycles since the last update
        let fromTime = this.scheduler.epoch - length;
        let bitIndex = 0;

        // start filling the out buffer with bits from the bitChange queue
        for (let i = 0; i < length; ++i) {
            // need some bits in the queue or just stick with the current bit value
            // i will be incrementing through the cycles so it will eventuall be greater than
            // the last bitChange cycle
            // when this happens, make the current bit that in the queue
            // NOTE: using bitIndex and splice to avoid using 'shift' which is O(n)
            while (bitIndex < this.bitChange.length && this.bitChange[bitIndex].cycles <= fromTime + i) {
                this.currentSpeakerBit = this.bitChange[bitIndex].bit;
                bitIndex++;
            }

            out[i + offset] += this.currentSpeakerBit;
        }

        // Remove processed bits from the queue
        if (bitIndex > 0) {
            this.bitChange.splice(0, bitIndex);
        }
    }

    // ATOM
    // record changes in the value in a FIFO queue
    // bit changed from the PPIA on the ATOM
    updateSpeaker(value, microCycle, seconds) {
        // value is usually 1, it is flipped between 1 and 0 when a sound is required

        // cycles is the number of cycles since the last update
        const cycles = microCycle + seconds / this.cpuFreq;

        const newbit = value ? 1.0 : 0.0;

        // create a FIFO queue and push on the newbit, and totalCycles
        this.bitChange.push({ bit: newbit, cycles: cycles });

        // running this program (from Atomic Theory and Practice) page 26
        // section 4.6.1 Labels - a to z
        // shows that the frequencies and sounds are right
        /*
        10 REM 322 Hz
        20 P=#B002
        30 FOR Z=0 TO 10000000 STEP 4;?P=Z;N.
        40 END
        RUN
        */

        // can also run the SYNTHESISER program from the ATOM MMC
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
