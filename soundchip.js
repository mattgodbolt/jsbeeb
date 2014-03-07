function SoundChip(sampleRate) {
    "use strict";
    var soundchipFreq = 4000000.0 / 16;
    var sampleDecrement = soundchipFreq / sampleRate;
    var samplesPerCycle = sampleRate / (2 * 1000 * 1000); // TODO hacky here

    var register = [ 0, 0, 0, 0 ];
    this.registers = register; // for debug
    var counter = [ 0, 0, 0, 0 ];
    var outputBit = [ 0, 0, 0, 0 ];
    var volume = [ 0, 0, 0, 0 ];
    this.volume = volume;  // for debug
    var generators = [ null, null, null, null ];

    var volumeTable = [];
    var f = 1.0;
    var i;
    for (i = 0; i < 16; ++i) {
        volumeTable[i] = f * 0.25;  // Bakes in the 1/4 volume per channel
        f *= Math.pow(10, -0.1);
    }
    volumeTable[15] = 0;

    function toneChannel(channel, out, offset, length) {
        var i;
        var reg = register[channel], vol = volume[channel];
        if (reg === 1) {
            for (i = 0; i < length; ++i) {
                out[i + offset] += vol;
            }
            return;
        }
        if (reg === 0) reg = 1024;
        for (i = 0; i < length; ++i) {
            counter[channel] -= sampleDecrement;
            if (counter[channel] < 0) {
                counter[channel] += reg;
                outputBit[channel] ^= 1;
            }
            out[i + offset] += outputBit[channel] ? vol : -vol;
        }
    }

    var lfsr = 0;
    function shiftLfsrWhiteNoise() {
        var bit = (lfsr & 1) ^ ((lfsr & (1<<3)) >> 3);
        lfsr = (lfsr >> 1) | (bit << 15);
    }
    function shiftLfsrPeriodicNoise() {
        lfsr >>= 1;
        if (lfsr === 0) lfsr = 1<<15;
    }
    var shiftLfsr = shiftLfsrWhiteNoise;
    function noisePoked() {
        shiftLfsr = register[3] & 4 ? shiftLfsrWhiteNoise : shiftLfsrPeriodicNoise;
        lfsr = 1<<15;
    }

    function addFor(channel) {
        channel = channel|0;
        switch (register[channel] & 3) {
        case 0: return 0x10;
        case 1: return 0x20;
        case 2: return 0x40;
        case 3: return register[channel - 1];
        }
    }

    function noiseChannel(channel, out, offset, length) {
        var add = addFor(channel), vol = volume[channel];
        for (var i = 0; i < length; ++i) {
            counter[channel] -= sampleDecrement;
            if (counter[channel] < 0) {
                counter[channel] += add;
                outputBit[channel] ^= 1;
                if (outputBit[channel]) shiftLfsr();
            }
            out[i + offset] += (lfsr & 1) ? vol : -vol;
        }
    }

    var enabled = true;
    function generate(out, offset, length) {
        offset = offset|0; length = length|0;
        var i;
        for (i = 0; i < length; ++i) {
            out[i + offset] = 0.0;
        }
        if (!enabled) return;
        for (i = 0; i < 4; ++i) {
            generators[i](i, out, offset, length);
        }
    }

    var residual = 0;
    var position = 0;
    var maxBufferSize = 4096;
    var buffer = new Float64Array(maxBufferSize);
    function render(out, offset, length) {
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
        var rounded = num|0;
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
        if ((value & 0x90) == 0x90) {
            // Volume setting
            var channel = (value >> 5) & 3;
            var newVolume = value & 0x0f;
            volume[channel] = volumeTable[newVolume];
        } else if ((value & 0x90) == 0x80) {
            latchedChannel = (value >> 5) & 3;
            register[latchedChannel] = (register[latchedChannel] & ~0x0f) | (value & 0x0f);
            if (latchedChannel == 3) {
                noisePoked();
            }
        } else {
            register[latchedChannel] = (register[latchedChannel] & 0x0f) | ((value & 0x3f) << 4);
        }
    }

    for (i = 0; i < 3; ++i) {
        generators[i] = toneChannel;
    }
    generators[3] = noiseChannel;

    this.advance = advance;
    this.render = render;
    this.poke = poke;
    this.enable = function(e) { enabled = e; };
    this.reset = function() {
        for (var i = 0; i < 4; ++i) {
            counter[i] = 0;
            register[i] = 0;
            volume[i] = 0; // ideally this would be volumeTable[0] to get the "boo" of "boo...beep".  But startup issues make the "boo" all clicky.
        }
        noisePoked();
        advance(100000);
    };
}
