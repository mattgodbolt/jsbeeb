define(['./utils'], function (utils) {
    "use strict";

    function SoundChip(sampleRate) {
        var cpuFreq = 1 / (2 * 1000 * 1000); // TODO hacky here
        // 4MHz input signal. Internal divide-by-8
        var soundchipFreq = 4000000.0 / 8;
        // Square wave changes every time a counter hits zero. Thus a full wave
        // needs to be 2x counter zeros.
        var waveDecrementPerSecond = soundchipFreq / 2;
        // Each sample in the buffer represents (1/sampleRate) time, so each time
        // we generate a sample, we need to decrement the counters by this amount:
        var sampleDecrement = waveDecrementPerSecond / sampleRate;
        // How many samples are generated per CPU cycle.
        var samplesPerCycle = sampleRate * cpuFreq;
        var minCyclesWELow = 14; // Somewhat empirically derived; Repton 2 has only 14 cycles between WE low and WE high (@0x2caa)

        var register = [0, 0, 0, 0];
        this.registers = register; // for debug
        var counter = [0, 0, 0, 0];
        var outputBit = [false, false, false, false];
        var volume = [0, 0, 0, 0];
        this.volume = volume;  // for debug
        var generators = [null, null, null, null, null];

        var volumeTable = [];
        var f = 1.0;
        var i;
        for (i = 0; i < 16; ++i) {
            volumeTable[i] = f / generators.length;  // Bakes in the per channel volume
            f *= Math.pow(10, -0.1);
        }
        volumeTable[15] = 0;

        var sineTableSize = 8192;
        var sineTable = [];
        for (i = 0; i < sineTableSize; ++i) {
            sineTable[i] = Math.sin(2 * Math.PI * i / sineTableSize) / generators.length;
        }
        var sineStep = 0;
        var sineOn = false;
        var sineTime = 0;

        function sineChannel(channel, out, offset, length) {
            if (!sineOn) {
                return;
            }
            for (var i = 0; i < length; ++i) {
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
            }
        };

        function toneChannel(channel, out, offset, length) {
            var i;
            var reg = register[channel], vol = volume[channel];
            if (reg === 0) reg = 1024;
            for (i = 0; i < length; ++i) {
                counter[channel] -= sampleDecrement;
                if (counter[channel] < 0) {
                    counter[channel] += reg;
                    outputBit[channel] = !outputBit[channel];
                }
                out[i + offset] += (outputBit[channel] * vol);
            }
        }

        var lfsr = 0;

        function shiftLfsrWhiteNoise() {
            var bit = (lfsr & 1) ^ ((lfsr & (1 << 1)) >>> 1);
            lfsr = (lfsr >>> 1) | (bit << 14);
        }

        function shiftLfsrPeriodicNoise() {
            lfsr >>= 1;
            if (lfsr === 0) lfsr = 1 << 14;
        }

        var shiftLfsr = shiftLfsrWhiteNoise;

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
            var add = addFor(channel), vol = volume[channel];
            for (var i = 0; i < length; ++i) {
                counter[channel] -= sampleDecrement;
                if (counter[channel] < 0) {
                    counter[channel] += add;
                    outputBit[channel] = !outputBit[channel];
                    if (outputBit[channel]) shiftLfsr();
                }
                out[i + offset] += ((lfsr & 1) * vol);
            }
        }

        var enabled = true;

        function generate(out, offset, length) {
            offset = offset | 0;
            length = length | 0;
            var i;
            for (i = 0; i < length; ++i) {
                out[i + offset] = 0.0;
            }
            if (!enabled) return;
            for (i = 0; i < generators.length; ++i) {
                generators[i](i, out, offset, length);
            }
        }

        var scheduler = {epoch: 0};
        var lastRunEpoch = 0;

        function catchUp() {
            var cyclesPending = scheduler.epoch - lastRunEpoch;
            if (cyclesPending > 0) {
                advance(cyclesPending);
            }
            lastRunEpoch = scheduler.epoch;
        }

        var activeTask = null;
        this.setScheduler = function (scheduler_) {
            scheduler = scheduler_;
            lastRunEpoch = scheduler.epoch;
            activeTask = scheduler.newTask(function () {
                if (this.active) {
                    poke(this.slowDataBus);
                }
            }.bind(this));
        };

        var residual = 0;
        var position = 0;
        var maxBufferSize = 4096;
        var buffer;
        if (typeof Float64Array !== "undefined") {
            buffer = new Float64Array(maxBufferSize);
        } else {
            buffer = new Float32Array(maxBufferSize);
        }

        function render(out, offset, length) {
            catchUp();
            var fromBuffer = position > length ? length : position;
            for (var i = 0; i < fromBuffer; ++i) {
                out[offset + i] = buffer[i];
            }
            offset += fromBuffer;
            length -= fromBuffer;
            for (i = fromBuffer; i < position; ++i) {
                buffer[i - fromBuffer] = buffer[i];
            }
            position -= fromBuffer;
            if (length !== 0) {
                generate(out, offset, length);
            }
        }

        function advance(time) {
            var num = time * samplesPerCycle + residual;
            var rounded = num | 0;
            residual = num - rounded;
            if (position + rounded >= maxBufferSize) {
                rounded = maxBufferSize - position;
            }
            if (rounded === 0) return;
            generate(buffer, position, rounded);
            position += rounded;
        }

        var latchedChannel = 0;

        function poke(value) {
            catchUp();
            var latchData = !!(value & 0x80);
            if (latchData)
                latchedChannel = (value >>> 5) & 3;
            if ((value & 0x90) === 0x90) {
                // Volume setting
                var newVolume = value & 0x0f;
                volume[latchedChannel] = volumeTable[newVolume];
            } else {
                // Data of some sort.
                if (latchedChannel === 3) {
                    // For noise channel we always update the bottom bits of the register.
                    register[latchedChannel] = value & 0x0f;
                    noisePoked();
                } else if (latchData) {
                    // Low 4 bits
                    register[latchedChannel] = (register[latchedChannel] & ~0x0f) | (value & 0x0f);
                } else {
                    // High bits
                    register[latchedChannel] = (register[latchedChannel] & 0x0f) | ((value & 0x3f) << 4);
                }
            }
        }

        for (i = 0; i < 3; ++i) {
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
            for (var i = 0; i < 4; ++i) {
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

    function FakeSoundChip() {
        this.reset = this.enable = this.mute = this.unmute = this.render = this.updateSlowDataBus = this.setScheduler = utils.noop;
        this.toneGenerator = this;
    }

    return {
        SoundChip: SoundChip,
        FakeSoundChip: FakeSoundChip
    };
});
