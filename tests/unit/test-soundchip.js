import { describe, it, expect } from "vitest";
import { SoundChip, AtomSoundChip, SoundBufferSamples } from "../../src/soundchip.js";
import { Scheduler } from "../../src/scheduler.js";

function makeSoundChip(onBuffer = () => {}) {
    const scheduler = new Scheduler();
    const chip = new SoundChip(onBuffer);
    chip.setScheduler(scheduler);
    return { chip, scheduler };
}

function makeAtomSoundChip() {
    const scheduler = new Scheduler();
    const chip = new AtomSoundChip(() => {});
    chip.setScheduler(scheduler);
    return { chip, scheduler };
}

describe("SoundChip advance", () => {
    it("should reuse one buffer for every onBuffer callback, never reallocating", () => {
        // Pins the buffer-reuse contract that works around crbug.com/537801199;
        // see the comment in SoundChip.advance(). Cross-call identity is the
        // key assertion: the old code handed out a fresh buffer per callback.
        let callbackCount = 0;
        let firstBuffer = null;
        const { chip } = makeSoundChip((buffer) => {
            if (firstBuffer === null) firstBuffer = buffer;
            expect(buffer).toBe(firstBuffer);
            callbackCount++;
        });

        // samplesPerCycle divides SoundBufferSamples exactly, so this fills the
        // buffer exactly three times and leaves position at zero.
        const cyclesToFillBufferThrice = Math.round((3 * SoundBufferSamples) / chip.samplesPerCycle);
        chip.advance(cyclesToFillBufferThrice);
        expect(callbackCount).toBe(3);
        expect(chip.buffer).toBe(firstBuffer);
        expect(chip.buffer.length).toBe(SoundBufferSamples);
        expect(chip.position).toBe(0);
    });

    // The guard states are unreachable through the public API (that's the
    // point), so these tests corrupt internal state to simulate a miscompile
    // or a reintroduced buffer transfer.
    it("should throw rather than spin if the buffer position goes bad", () => {
        const { chip } = makeSoundChip();
        chip.position = SoundBufferSamples;
        expect(() => chip.advance(1024)).toThrow("Sound buffer accounting error");
    });

    it("should throw rather than fall silent if the buffer is detached or replaced", () => {
        const { chip } = makeSoundChip();
        chip.buffer = new Float32Array(0); // what a detached buffer reports
        expect(() => chip.advance(1024)).toThrow("Sound buffer accounting error");
    });
});

// Amplitude of the frequency-bin component at freq, via the Goertzel algorithm.
function goertzelAmplitude(samples, freq, sampleRate) {
    const w = (2 * Math.PI * freq) / sampleRate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (const sample of samples) {
        const s0 = sample + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / samples.length;
}

describe("SoundChip DC restoration", () => {
    // 500 kHz chip rate; the blocker's 47 ms time constant settles well inside half a second.
    const SettleSamples = 250000;

    function settle(chip, scratch) {
        for (let done = 0; done < SettleSamples; done += scratch.length) chip.generate(scratch, 0, scratch.length);
    }

    it("should centre a steady tone around zero instead of riding a pedestal", () => {
        const { chip } = makeSoundChip();
        chip.poke(0x80 | 0x00); // channel 0, period low nibble
        chip.poke(0x20); // period high bits: period 512, a 2048-sample square
        chip.poke(0x90 | 0x00); // channel 0, full volume
        const out = new Float32Array(4096); // exactly two square-wave periods
        settle(chip, out);
        chip.generate(out, 0, out.length);

        let mean = 0;
        let min = Infinity;
        let max = -Infinity;
        for (const sample of out) {
            mean += sample;
            min = Math.min(min, sample);
            max = Math.max(max, sample);
        }
        mean /= out.length;
        // Unipolar output would have mean vol/2 = 0.125 and min 0.
        expect(Math.abs(mean)).toBeLessThan(0.01);
        expect(max).toBeGreaterThan(0.1);
        expect(min).toBeLessThan(-0.1);
    });

    it("should preserve volume-register PCM on a period-1 carrier", () => {
        // Sampled speech sets tone period 1 (a 125 kHz carrier) and writes the
        // sample data to the volume register: the audio is the carrier's mean
        // level, vol/2. A zero-mean (bipolar) output would silence it, which
        // is why the generators stay unipolar (issue #863).
        const { chip } = makeSoundChip();
        chip.poke(0x80 | 0x01); // channel 0, period 1
        chip.poke(0x00);
        const half = 250; // half a 1 kHz modulation period at 500 kHz
        const chunk = new Float32Array(half);
        settle(chip, chunk);

        const modulated = [];
        const totalHalves = 100; // 50 cycles of 1 kHz, an integral Goertzel bin
        for (let i = 0; i < totalHalves; ++i) {
            chip.poke(0x90 | (i % 2 ? 0x08 : 0x00));
            chip.generate(chunk, 0, half);
            modulated.push(...chunk);
        }
        // Means are vol/2 = 0.125 and 0.0198, so the 1 kHz square modulation
        // has a fundamental of ((0.125 - 0.0198) / 2) * 4/pi = 0.067.
        const amplitude = goertzelAmplitude(modulated, 1000, chip.soundchipFreq);
        expect(amplitude).toBeGreaterThan(0.05);
        expect(amplitude).toBeLessThan(0.09);
    });
});

describe("SoundChip snapshotState / restoreState", () => {
    it("should snapshot and restore tone channel registers", () => {
        const { chip } = makeSoundChip();
        chip.registers[0] = 0x100;
        chip.registers[1] = 0x200;
        chip.registers[2] = 0x300;
        chip.counter[0] = 1.5;
        chip.counter[1] = 2.5;
        chip.outputBit[0] = true;
        chip.outputBit[2] = true;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.registers[0]).toBe(0x100);
        expect(chip2.registers[1]).toBe(0x200);
        expect(chip2.registers[2]).toBe(0x300);
        expect(chip2.counter[0]).toBeCloseTo(1.5);
        expect(chip2.counter[1]).toBeCloseTo(2.5);
        expect(chip2.outputBit[0]).toBe(true);
        expect(chip2.outputBit[1]).toBe(false);
        expect(chip2.outputBit[2]).toBe(true);
    });

    it("should snapshot and restore volume levels", () => {
        const { chip } = makeSoundChip();
        chip.poke(0x90 | 0x05); // Channel 0, volume 5
        chip.poke(0xb0 | 0x0a); // Channel 1, volume 10

        const v0 = chip.volume[0];
        const v1 = chip.volume[1];

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.volume[0]).toBeCloseTo(v0);
        expect(chip2.volume[1]).toBeCloseTo(v1);
    });

    it("should snapshot and restore LFSR and noise state", () => {
        const { chip } = makeSoundChip();
        // Set to periodic noise
        chip.registers[3] = 0x02;
        chip.noisePoked();
        // Shift LFSR a few times to get a non-default value
        chip.shiftLfsr();
        chip.shiftLfsr();
        chip.shiftLfsr();
        const lfsrVal = chip.lfsr;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.lfsr).toBe(lfsrVal);
        expect(chip2.registers[3]).toBe(0x02);
        // Verify periodic noise LFSR function is bound (not white noise)
        chip2.shiftLfsr();
        chip.shiftLfsr();
        expect(chip2.lfsr).toBe(chip.lfsr);
    });

    it("should snapshot and restore white noise LFSR binding", () => {
        const { chip } = makeSoundChip();
        // Set to white noise (bit 2 set)
        chip.registers[3] = 0x07;
        chip.noisePoked();
        chip.shiftLfsr();
        chip.shiftLfsr();
        const lfsrVal = chip.lfsr;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.lfsr).toBe(lfsrVal);
        // Verify white noise LFSR function is bound
        chip2.shiftLfsr();
        chip.shiftLfsr();
        expect(chip2.lfsr).toBe(chip.lfsr);
    });

    it("should snapshot and restore latched register", () => {
        const { chip } = makeSoundChip();
        chip.latchedRegister = 0x60;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.latchedRegister).toBe(0x60);
    });

    it("should snapshot and restore the DC blocker state", () => {
        const { chip } = makeSoundChip();
        chip.dcPrevIn = 0.125;
        chip.dcPrevOut = -0.0625;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.dcPrevIn).toBeCloseTo(0.125);
        expect(chip2.dcPrevOut).toBeCloseTo(-0.0625);
    });

    it("should zero the DC blocker for snapshots that predate it", () => {
        const { chip } = makeSoundChip();
        const snapshot = chip.snapshotState();
        delete snapshot.dcPrevIn;
        delete snapshot.dcPrevOut;
        chip.dcPrevIn = 0.5;
        chip.dcPrevOut = 0.5;
        chip.restoreState(snapshot);

        expect(chip.dcPrevIn).toBe(0);
        expect(chip.dcPrevOut).toBe(0);
    });

    it("should snapshot and restore sine generator state", () => {
        const { chip } = makeSoundChip();
        chip.sineOn = true;
        chip.sineStep = 42.5;
        chip.sineTime = 100.25;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.sineOn).toBe(true);
        expect(chip2.sineStep).toBeCloseTo(42.5);
        expect(chip2.sineTime).toBeCloseTo(100.25);
    });

    it("should reset output buffer on restore", () => {
        const { chip } = makeSoundChip();
        chip.position = 100;
        chip.buffer[0] = 0.5;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.position = 50;
        chip2.restoreState(snapshot);

        expect(chip2.position).toBe(0);
    });

    it("should produce isolated snapshots", () => {
        const { chip } = makeSoundChip();
        chip.registers[0] = 0x123;

        const snapshot = chip.snapshotState();
        chip.registers[0] = 0x456;

        // Snapshot should not be affected by subsequent changes
        expect(snapshot.registers[0]).toBe(0x123);
    });
});

describe("AtomSoundChip", () => {
    it("should have speakerGenerator with mute and pushBit", () => {
        const { chip } = makeAtomSoundChip();
        expect(chip.speakerGenerator).toBeDefined();
        expect(typeof chip.speakerGenerator.mute).toBe("function");
        expect(typeof chip.speakerGenerator.pushBit).toBe("function");
    });

    it("should use 1 MHz samplesPerCycle by default", () => {
        const { chip } = makeAtomSoundChip();
        expect(chip.samplesPerCycle).toBeCloseTo(chip.soundchipFreq / 1000000);
    });

    it("speakerReset should clear the bit change queue", () => {
        const { chip } = makeAtomSoundChip();
        chip.bitChange.push({ bit: 1.0, cycles: 100 });
        chip.speakerReset();
        expect(chip.bitChange).toHaveLength(0);
        expect(chip.currentSpeakerBit).toBe(0.0);
    });

    it("updateSpeaker should record bit transitions", () => {
        const { chip } = makeAtomSoundChip();
        chip.updateSpeaker(1, 100, 0);
        chip.updateSpeaker(0, 200, 0);
        expect(chip.bitChange).toHaveLength(2);
        expect(chip.bitChange[0].bit).toBe(1.0);
        expect(chip.bitChange[1].bit).toBe(0.0);
    });

    it("should not run BBC tone/noise channels", () => {
        const { chip } = makeAtomSoundChip();
        chip.registers[0] = 100;
        chip.volume[0] = 0.25;
        const out = new Float32Array(32);
        chip.generate(out, 0, 32);
        // No BBC tone output (only sine + speaker generators)
        expect(out.every((v) => Math.abs(v) < 0.01)).toBe(true);
    });

    it("BBC SoundChip should not have speaker channel", () => {
        const { chip } = makeSoundChip();
        // BBC SoundChip has 5 generators (3 tone + noise + sine), no speaker
        expect(chip.generators).toHaveLength(5);
        expect(chip.speakerGenerator).toBeUndefined();
    });

    it("should place transitions correctly when advance() splits into chunks", () => {
        // The buffer is 512 samples. Advancing 1200 cycles at 0.5 spc =
        // 600 samples, which splits into chunk 1 (512 samples) and chunk 2
        // (88 samples). A bit change at cycle 1100 falls in the second
        // chunk (sample 550 = cycle 1100 * 0.5). If speakerChannel uses
        // epoch - length for each chunk independently, it miscomputes the
        // time window and places the transition in the wrong chunk.
        const { chip, scheduler } = makeAtomSoundChip();
        chip.speakerReset();
        chip.enabled = true;

        // Set lastRunEpoch = 0 (start of window), then advance to cycle 1200
        chip.lastRunEpoch = 0;
        scheduler.epoch = 1200;
        chip.bitChange.push({ bit: 1.0, cycles: 1100 });

        // Capture the buffer output callback
        const buffers = [];
        chip._onBuffer = (buf) => buffers.push(new Float32Array(buf));

        chip.advance(1200);

        // The bit change at cycle 1100 → sample 550 (in the second chunk).
        // First buffer (512 samples) should be silent (all zero before DC filter).
        // If the bug is present, the transition lands in the first chunk instead.
        const firstBuf = buffers[0];
        expect(firstBuf).toBeDefined();
        expect(firstBuf[511]).toBeCloseTo(0.0, 2); // last sample of first chunk: silent

        // Second chunk is in chip.buffer[0..87]. Check the transition is there.
        // Cycle 1100 → sample 550. Chunk 2 starts at sample 512, so the
        // transition is at local index 550 - 512 = 38.
        expect(chip.buffer[37]).toBeCloseTo(0.0, 2); // before transition
        expect(chip.buffer[38]).toBeGreaterThan(0); // transition happened
    });

    it("speakerChannel should place transitions at the correct sample index", () => {
        // The speaker bug: speakerChannel subtracted sample count from cycle
        // epoch, mixing units. With samplesPerCycle=0.5, a bit change at CPU
        // cycle 150 when generating 100 samples (=200 cycles) ending at
        // epoch 200 should appear at sample 75 (= 150 * 0.5), not sample 50.
        const { chip, scheduler } = makeAtomSoundChip();
        chip.speakerReset();
        scheduler.epoch = 200;
        chip.bitChange.push({ bit: 1.0, cycles: 150 });

        const out = new Float32Array(100);
        chip.speakerChannel(1, out, 0, 100);

        // Sample 74 should still be zero (before transition)
        expect(out[74]).toBeCloseTo(0.0, 2);
        // Sample 75 should be positive (transition happened)
        expect(out[75]).toBeGreaterThan(0);
    });

    it("speakerChannel should produce output from bit transitions and consume them", () => {
        const { chip, scheduler } = makeAtomSoundChip();
        chip.speakerReset();
        // At 0.5 samples/cycle, 16 samples = 32 cycles.
        // Set epoch=32 so the buffer covers cycles 0-32.
        // Bit changes at cycles 10 and 20 → samples 5 and 10.
        chip.bitChange.push({ bit: 1.0, cycles: 10 });
        chip.bitChange.push({ bit: 0.0, cycles: 20 });
        scheduler.epoch = 32;

        const out = new Float32Array(16);
        chip.speakerChannel(1, out, 0, 16);

        // Before sample 5: silence (no transitions yet)
        expect(out[0]).toBeCloseTo(0.0, 2);
        expect(out[4]).toBeCloseTo(0.0, 2);
        // At sample 5 (cycle 10): bit goes high, output jumps positive
        expect(out[5]).toBeGreaterThan(0);
        // At sample 10 (cycle 20): bit goes low, output changes sign
        expect(out[10]).toBeLessThan(out[9]);
        // After all transitions consumed, output decays toward 0
        expect(Math.abs(out[15])).toBeLessThan(Math.abs(out[10]));
        // Transitions should be consumed
        expect(chip.bitChange).toHaveLength(0);
    });
});

describe("SoundChip events", () => {
    function makeEventChip() {
        const events = [];
        const scheduler = new Scheduler();
        const chip = new SoundChip(() => {}, { onEvent: (event) => events.push(event) });
        chip.setScheduler(scheduler);
        return { chip, scheduler, events };
    }

    it("should stamp each write with the cycle it takes effect at", () => {
        const { chip, scheduler, events } = makeEventChip();
        scheduler.polltime(1234);
        chip.poke(0x8d);
        scheduler.polltime(10);
        chip.poke(0x07);
        expect(events).toEqual([
            { cycle: 1234, kind: "poke", value: 0x8d },
            { cycle: 1244, kind: "poke", value: 0x07 },
        ]);
    });

    it("should report tape tones, resets and restores as events, but not muting, which is not chip state", () => {
        const { chip, events } = makeEventChip();
        chip.toneGenerator.tone(1200);
        chip.toneGenerator.mute();
        chip.mute();
        chip.reset(false);
        chip.reset(true);
        chip.restoreState(chip.snapshotState());
        expect(events.map((event) => event.kind)).toEqual(["sine", "sine", "reset", "state"]);
        expect(events[0].value).toBe(1200);
        expect(events[1].value).toBe(0);
        expect(chip.enabled).toBe(false);
    });

    it("should report progress every few emulated milliseconds, and keep doing so after a restore", () => {
        const { chip, scheduler, events } = makeEventChip();
        scheduler.polltime(10000);
        expect(events).toEqual([
            { cycle: 4000, kind: "progress", value: true },
            { cycle: 8000, kind: "progress", value: true },
        ]);
        scheduler.restoreState({ epoch: 20000 });
        chip.restoreState(chip.snapshotState());
        events.length = 0;
        scheduler.polltime(4000);
        expect(events).toEqual([{ cycle: 24000, kind: "progress", value: true }]);
    });

    it("should not render when it has an event sink", () => {
        const buffers = [];
        const scheduler = new Scheduler();
        const chip = new SoundChip((buffer) => buffers.push(buffer), { onEvent: () => {} });
        chip.setScheduler(scheduler);
        scheduler.polltime(2000000);
        chip.catchUp();
        expect(buffers).toEqual([]);
    });

    it("should render the same output from the events as the chip they came from", () => {
        const { chip: source, scheduler, events } = makeEventChip();
        const { chip: renderer } = makeSoundChip();
        source.poke(0x8d);
        source.poke(0x07);
        source.poke(0x90);
        scheduler.polltime(4000);
        source.poke(0x9f);
        for (const event of events) renderer.applyEvent(event);
        const out = new Float32Array(2000);
        renderer.renderAt(0, out, 0, out.length);
        // With the tone latched then silenced, applying every event at once leaves silence.
        expect(Math.max(...out) - Math.min(...out)).toBeLessThan(1e-3);

        const { chip: playing } = makeSoundChip();
        for (const event of events.slice(0, 3)) playing.applyEvent(event);
        playing.renderAt(0, out, 0, out.length);
        expect(goertzelAmplitude(out, 1000, 500000)).toBeGreaterThan(0.05);
    });

    it("should carry Atom speaker bits as events with their exact cycle", () => {
        const events = [];
        const scheduler = new Scheduler();
        const chip = new AtomSoundChip(() => {}, { onEvent: (event) => events.push(event) });
        chip.setScheduler(scheduler);
        chip.updateSpeaker(true, 10, 0.5);
        expect(events).toEqual([{ cycle: 10 + 0.5 * 1000000, kind: "bit", value: 1 }]);
        expect(chip.bitChange).toEqual([]);

        const { chip: renderer } = makeAtomSoundChip();
        renderer.applyEvent(events[0]);
        expect(renderer.bitChange).toEqual([{ bit: 1, cycles: 10 + 0.5 * 1000000 }]);
    });
});
