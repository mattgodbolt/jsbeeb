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
    speakerReset() {
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
    speakerChannel(channel, out, offset, length) {
        // soundchip _reset_ will advance the buffer 100000 cycles (or 4410 samples)
        //  which is rounded to buffer size of 4096
        //

        // the catchup() in updateSpeaker() will cause this to be called every time a sample can
        // be played, but it just buffers up the result and doesn't play it.
        // a real 'render' is when the length is about 2048 or higher

        // speakerBuffer contains the data from the CPU
        // the start of that data is speakerTime and it wraps around
        // the buffer is unlikely to fill since the speakerBufferSize is 4 times bigger than
        // the average length that is grabbed by this function
        // NOTE: bufferPos is the position that the CPU is copying data into this buffer
        // NOTE: numSamplesAdded is the number of samples that were added since this function last was called

        // this function must copy the data from speakerBuffer into out, starting at offset until length
        // it doesn't need to wrap the out as it will be larger than offset+length (I think)

        // if (length !== numSamplesAdded)
        //     console.log("offset+length (" + offset + "+" + length + ") = " + (offset + length) + ", speakerTime " + speakerTime + ", numSamplesAdded " + numSamplesAdded + ", bufferPos " + bufferPos);

        // this is the last bit that was copied into out
        let lastbit = this.speakerBuffer[this.speakerTime];

        // fill the out buffer with length samples
        // it will use data from the speakerBuffer until it runs out; and then it will repeat the
        // last bit until the out buffer is full
        for (let i = 0; i < length; ++i) {
            // got a real sample, so grab it.  If not, just keep using the last correct value
            if (i < this.numSamplesAdded)
                lastbit = this.speakerBuffer[(this.speakerTime + i) & (this.speakerBufferSize - 1)];

            out[i + offset] += lastbit;
        }

        this.speakerTime += this.numSamplesAdded;

        while (this.speakerTime >= this.speakerBufferSize) this.speakerTime -= this.speakerBufferSize;
        this.numSamplesAdded = 0;
    }

    // ATOM
    // fill the buffer with the last value
    // polled from the PPIA on the ATOM
    updateSpeaker(value, microCycle, seconds, cycles) {
        // value - true for 1, false for 0

        // calculate the number of buffer values to fill
        let deltaSeconds = seconds - this.lastSecond;
        let deltaCycles = microCycle - this.lastMicroCycle;

        // deltaSeconds is seconds since last last update
        // deltaCycles is microcycles since last update

        let totalCycles = this.outstandingCycles + deltaCycles + deltaSeconds / this.cpuFreq;

        if (totalCycles === cycles) console.log("updatespeaker cycles same");

        //convert totalCycles to totalSamples at samplerate
        let totalSamples = (totalCycles * this.samplesPerCycle) | 0;

        if (totalSamples === 0) this.outstandingCycles = totalCycles;
        else this.outstandingCycles = totalCycles - 1 / this.samplesPerCycle;

        let lastbit = this.speakerBuffer[this.bufferPos];

        if (totalSamples >= this.speakerBufferSize) {
            console.log(
                "speaker buffer too small " + this.bufferPos + " " + totalSamples + " >= " + this.speakerBufferSize,
            );
            // clear out the buffer with zeros
            this.outstandingCycles = 0;
            this.bufferPos = 0;
        } else {
            // fill the buffer with the last value that was set
            for (var i = 0; i < totalSamples; ++i) {
                this.speakerBuffer[this.bufferPos & (this.speakerBufferSize - 1)] = lastbit;
                this.bufferPos++;
            }
            while (this.bufferPos >= this.speakerBufferSize) this.bufferPos -= this.speakerBufferSize;
            this.numSamplesAdded += totalSamples;
        }
        let newbit = value ? 1.0 : 0.0;

        // record the current value
        this.speakerBuffer[this.bufferPos] = newbit;

        // // testAudio
        // samplesSinceLastValueChange+=totalSamples;
        // if ( lastbit !== newbit ) {
        //     // samples since last change is only half a cycle so multiply by 2
        //     console.log("updateSpeaker frequency: " + sampleRate / (samplesSinceLastValueChange * 2) + "hz");
        //     samplesSinceLastValueChange=0;
        // }

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

        // start the next update from this point
        this.lastSecond = seconds;
        this.lastMicroCycle = microCycle;
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

//     // poke() triggered by the emulator to latch relevant data
//     // on Acorn Atom this is really just using the 'catchup' regularly.

//     //Acorn Atom
//     generators[5] = speakerChannel;

//     var speakerBufferSize = 8192;
//     var speakerBuffer = [];
//     for (i = 0; i < speakerBufferSize; ++i) {
//         speakerBuffer[i] = 0.0;
//     }

//     var speakerTime = 0;
//     var bufferPos = speakerBufferSize >> 1; // start buffer half way through buffer and speakertime at the beginning
//     // // test audio
//     // var samplesSinceLastValueChange = 0;

//     var lastSecond = 0;
//     var lastMicroCycle = 0;
//     var outstandingCycles = 0;

//     var numSamplesAdded = 0;

//     function speakerReset() {
//         for (i = 0; i < speakerBufferSize; ++i) {
//             speakerBuffer[i] = 0.0;
//         }

//         speakerTime = 0;
//         bufferPos = speakerBufferSize >> 1; // start buffer half way through buffer and speakertime at the beginning

//         lastSecond = 0;
//         lastMicroCycle = 0;
//         outstandingCycles = 0;

//         numSamplesAdded = 0;
//     }

//     // called by the generator to pump samples to the output
//     function speakerChannel(channel, out, offset, length) {
//         // soundchip _reset_ will advance the buffer 100000 cycles (or 4410 samples)
//         //  which is rounded to buffer size of 4096
//         //

//         // the catchup() in updateSpeaker() will cause this to be called every time a sample can
//         // be played, but it just buffers up the result and doesn't play it.
//         // a real 'render' is when the length is about 2048 or higher

//         // speakerBuffer contains the data from the CPU
//         // the start of that data is speakerTime and it wraps around
//         // the buffer is unlikely to fill since the speakerBufferSize is 4 times bigger than
//         // the average length that is grabbed by this function
//         // NOTE: bufferPos is the position that the CPU is copying data into this buffer
//         // NOTE: numSamplesAdded is the number of samples that were added since this function last was called

//         // this function must copy the data from speakerBuffer into out, starting at offset until length
//         // it doesn't need to wrap the out as it will be larger than offset+length (I think)

//         // if (length !== numSamplesAdded)
//         //     console.log("offset+length (" + offset + "+" + length + ") = " + (offset + length) + ", speakerTime " + speakerTime + ", numSamplesAdded " + numSamplesAdded + ", bufferPos " + bufferPos);

//         // this is the last bit that was copied into out
//         var lastbit = speakerBuffer[speakerTime];

//         // fill the out buffer with length samples
//         // it will use data from the speakerBuffer until it runs out; and then it will repeat the
//         // last bit until the out buffer is full
//         for (var i = 0; i < length; ++i) {
//             // got a real sample, so grab it.  If not, just keep using the last correct value
//             if (i < numSamplesAdded) lastbit = speakerBuffer[(speakerTime + i) & (speakerBufferSize - 1)];

//             out[i + offset] += lastbit;
//         }

//         speakerTime += numSamplesAdded;

//         while (speakerTime >= speakerBufferSize) speakerTime -= speakerBufferSize;
//         numSamplesAdded = 0;
//     }

//     // fill the buffer with the last value
//     this.updateSpeaker = function (value, microCycle, seconds, cycles) {
//         // value - true for 1, false for 0

//         // calculate the number of buffer values to fill
//         var deltaSeconds = seconds - lastSecond;
//         var deltaCycles = microCycle - lastMicroCycle;

//         // deltaSeconds is seconds since last last update
//         // deltaCycles is microcycles since last update

//         var totalCycles = outstandingCycles + deltaCycles + deltaSeconds / cpuFreq;

//         if (totalCycles === cycles) console.log("updatespeaker cycles same");

//         //convert totalCycles to totalSamples at samplerate
//         var totalSamples = (totalCycles * samplesPerCycle) | 0;

//         if (totalSamples === 0) outstandingCycles = totalCycles;
//         else outstandingCycles = totalCycles - 1 / samplesPerCycle;

//         var lastbit = speakerBuffer[bufferPos];

//         if (totalSamples >= speakerBufferSize) {
//             console.log("speaker buffer too small " + bufferPos + " " + totalSamples + " >= " + speakerBufferSize);
//             // clear out the buffer with zeros
//             outstandingCycles = 0;
//             bufferPos = 0;
//         } else {
//             // fill the buffer with the last value that was set
//             for (var i = 0; i < totalSamples; ++i) {
//                 speakerBuffer[bufferPos & (speakerBufferSize - 1)] = lastbit;
//                 bufferPos++;
//             }
//             while (bufferPos >= speakerBufferSize) bufferPos -= speakerBufferSize;
//             numSamplesAdded += totalSamples;
//         }
//         var newbit = value ? 1.0 : 0.0;

//         // record the current value
//         speakerBuffer[bufferPos] = newbit;

//         // // testAudio
//         // samplesSinceLastValueChange+=totalSamples;
//         // if ( lastbit !== newbit ) {
//         //     // samples since last change is only half a cycle so multiply by 2
//         //     console.log("updateSpeaker frequency: " + sampleRate / (samplesSinceLastValueChange * 2) + "hz");
//         //     samplesSinceLastValueChange=0;
//         // }

//         // running this program (from Atomic Theory and Practice) page 26
//         // section 4.6.1 Labels - a to z
//         // shows that the frequencies and sounds are right
//         /*
// 10 REM 322 Hz
// 20 P=#B002
// 30 FOR Z=0 TO 10000000 STEP 4;?P=Z;N.
// 40 END
// RUN
// */

//         // start the next update from this point
//         lastSecond = seconds;
//         lastMicroCycle = microCycle;
//     };

//     this.reset = function (hard) {
//         if (!hard) return;
//         for (var i = 0; i < 4; ++i) {
//             counter[i] = 0;
//             register[i] = 0;
//             volume[i] = 0; // ideally this would be volumeTable[0] to get the "boo" of "boo...beep".  But startup issues make the "boo" all clicky.
//         }
//         noisePoked();
//         advance(100000);
//         this.setScheduler(scheduler);
//         speakerReset(); // ACORN ATOM
//     };
//     this.enable = function (e) {
//         enabled = e;
//     };
//     this.mute = function () {
//         enabled = false;
//     };
//     this.unmute = function () {
//         enabled = true;
//     };
// }
