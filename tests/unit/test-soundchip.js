import { describe, it, expect } from "vitest";
import {
    SoundChip,
    AtomSoundChip,
    InstrumentedSoundChip,
    SoundBufferSamples,
    ToneCounterSteps,
} from "../../src/soundchip.js";
import { Scheduler } from "../../src/scheduler.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";
import { goertzelAmplitude } from "./helpers.js";

const WhiteNoiseFastestRate = 0xe4;
const PeriodicNoiseFastestRate = 0xe0;
const Tone0Latch = 0x80;
const Tone0LowBitsSaved = 0x0f;
const Tone0LowBitsDriven = 0x03;
const CyclesIntoWriteAtSnapshot = 5;

function makeSoundChip(onBuffer = () => {}) {
    const scheduler = new Scheduler();
    const chip = new SoundChip(onBuffer);
    chip.setScheduler(scheduler);
    return { chip, scheduler };
}

function makeAtomSoundChip(onBuffer = () => {}) {
    const scheduler = new Scheduler();
    const chip = new AtomSoundChip(onBuffer);
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
    it.each([
        ["spin if the buffer position goes bad", (chip) => (chip.position = SoundBufferSamples)],
        // An empty buffer is what a detached one reports.
        ["fall silent if the buffer is detached or replaced", (chip) => (chip.buffer = new Float32Array(0))],
    ])("should throw rather than %s", (_, corrupt) => {
        const { chip } = makeSoundChip();
        corrupt(chip);
        expect(() => chip.advance(1024)).toThrow("Sound buffer accounting error");
    });
});

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

describe("SoundChip tone period 0", () => {
    // A square wave lasts four samples per unit of period; periodic noise repeats every 15 of tone 2's waves.
    const SamplesPerWave = 4 * ToneCounterSteps;

    function risingEdgeSpacings(chip, samples) {
        const out = new Float32Array(samples);
        chip.generate(out, 0, samples);
        const edges = [];
        for (let i = 1; i < samples; ++i) if (out[i] - out[i - 1] > 0.1) edges.push(i);
        return new Set(edges.slice(1).map((edge, i) => edge - edges[i]));
    }

    it.each([
        ["tone 2", [0xd0, 0xff], SamplesPerWave],
        ["periodic noise following tone 2", [0xdf, 0xe3, 0xf0], 15 * SamplesPerWave],
    ])("should count a period of 0 as the full counter for %s", (_, pokes, spacing) => {
        const { chip } = makeSoundChip();
        for (const value of [0xc0, 0x00, ...pokes]) chip.poke(value);
        expect(risingEdgeSpacings(chip, 5 * spacing)).toEqual(new Set([spacing]));
    });
});

describe("SoundChip snapshotState / restoreState", () => {
    it("round-trips a chip part way through playing three tones, periodic noise and a cassette tone", async () => {
        const scheduler = new Scheduler();
        await expectSnapshotRoundTrips(
            () => {
                const chip = new SoundChip(() => {});
                chip.setScheduler(scheduler);
                return chip;
            },
            (driven) => {
                for (const [channel, period, volume] of [
                    [0, 0x123, 3],
                    [1, 0x045, 7],
                    [2, 0x3f0, 11],
                ]) {
                    driven.poke(0x80 | (channel << 5) | (period & 0x0f));
                    driven.poke(period >> 4);
                    driven.poke(0x90 | (channel << 5) | volume);
                }
                driven.poke(PeriodicNoiseFastestRate);
                driven.toneGenerator.tone(1200);
                scheduler.polltime(12345);
                driven.catchUp();
            },
        );
    });

    it.each([
        ["white noise over periodic", WhiteNoiseFastestRate, PeriodicNoiseFastestRate],
        ["periodic noise over white", PeriodicNoiseFastestRate, WhiteNoiseFastestRate],
    ])("should shift a restored LFSR as the restored noise register says: %s", (_, savedNoise, restoredOverNoise) => {
        const twentyShifts = (chip) =>
            Array.from({ length: 20 }, () => {
                chip.shiftLfsr();
                return chip.lfsr;
            });
        const { chip } = makeSoundChip();
        chip.poke(savedNoise);
        twentyShifts(chip);
        const { chip: chip2 } = makeSoundChip();
        chip2.poke(restoredOverNoise);

        chip2.restoreState(chip.snapshotState());
        expect(twentyShifts(chip2)).toEqual(twentyShifts(chip));
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

    it.each([
        ["its own pending write", () => {}, Tone0LowBitsSaved],
        [
            "what the System VIA drove, for a snapshot without the bus",
            (snapshot) => {
                delete snapshot.slowDataBus;
                delete snapshot.active;
                delete snapshot.activeTaskOffset;
            },
            Tone0LowBitsDriven,
        ],
    ])("takes the bus with WE low as %s after a restore", (_, age, expectedRegister) => {
        const { chip, scheduler } = makeSoundChip();
        chip.updateSlowDataBus(Tone0Latch | Tone0LowBitsSaved, true);
        scheduler.polltime(CyclesIntoWriteAtSnapshot);
        const snapshot = chip.snapshotState();
        age(snapshot);

        const { chip: restored, scheduler: restoredScheduler } = makeSoundChip();
        restored.updateSlowDataBus(Tone0Latch | Tone0LowBitsDriven, true);
        restored.restoreState(snapshot);
        restoredScheduler.polltime(restored.minCyclesWELow);

        expect(restored.registers[0]).toBe(expectedRegister);
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
});

describe("AtomSoundChip", () => {
    // The Atom's speaker is sampled at half its 1MHz CPU clock, so cycle n lands on sample n / 2.
    function playSpeaker(bits, { untilCycle, onBuffer, mute = false }) {
        const { chip, scheduler } = makeAtomSoundChip(onBuffer);
        for (const [bit, cycle] of bits) chip.speakerGenerator.pushBit(bit, cycle, 0);
        if (mute) chip.speakerGenerator.mute();
        scheduler.epoch = untilCycle;
        return chip;
    }

    function render(chip, samples) {
        const out = new Float32Array(samples);
        chip.render(out, 0, samples);
        return out;
    }

    it("sounds a speaker transition at the sample its cycle falls on", () => {
        const out = render(playSpeaker([[1, 150]], { untilCycle: 200 }), 100);
        expect(out[74]).toBeCloseTo(0.0, 2);
        expect(out[75]).toBeGreaterThan(0);
    });

    it("follows the speaker down again and lets it decay", () => {
        const out = render(
            playSpeaker(
                [
                    [1, 10],
                    [0, 20],
                ],
                { untilCycle: 32 },
            ),
            16,
        );
        expect(out[4]).toBeCloseTo(0.0, 2);
        expect(out[5]).toBeGreaterThan(0);
        expect(out[10]).toBeLessThan(out[9]);
        expect(Math.abs(out[15])).toBeLessThan(Math.abs(out[10]));
    });

    it("places a transition in the right buffer when one catch-up fills more than a buffer", () => {
        let firstBuffer;
        const chip = playSpeaker([[1, 1100]], {
            untilCycle: 1200,
            onBuffer: (buffer) => (firstBuffer = new Float32Array(buffer)),
        });
        const rest = render(chip, 600 - SoundBufferSamples);
        expect(firstBuffer[SoundBufferSamples - 1]).toBeCloseTo(0.0, 2);
        expect(rest[550 - SoundBufferSamples - 1]).toBeCloseTo(0.0, 2);
        expect(rest[550 - SoundBufferSamples]).toBeGreaterThan(0);
    });

    it("forgets the transitions still to play when muted", () => {
        const out = render(playSpeaker([[1, 100]], { untilCycle: 200, mute: true }), 100);
        expect(out.every((v) => v === 0)).toBe(true);
    });

    describe("snapshotState / restoreState", () => {
        it("round-trips the speaker's level", async () => {
            await expectSnapshotRoundTrips(
                () => makeAtomSoundChip().chip,
                (chip) => chip.speakerGenerator.pushBit(1, 10, 0),
            );
        });

        it("sounds the restored level, settled, so the next edge after a restore is heard", () => {
            const { chip: saved, scheduler } = makeAtomSoundChip();
            saved.speakerGenerator.pushBit(1, 10, 0);
            scheduler.epoch = 100;
            const snapshot = saved.snapshotState();

            const { chip, scheduler: restoredScheduler } = makeAtomSoundChip();
            chip.speakerGenerator.pushBit(1, 10, 0);
            restoredScheduler.epoch = 20;
            render(chip, 10);
            chip.restoreState(snapshot);
            chip.speakerGenerator.pushBit(0, 50, 0);
            restoredScheduler.epoch = 60;
            const out = render(chip, 20);
            expect(out.slice(0, 15).every((v) => Math.abs(v) < 0.01)).toBe(true);
            expect(out[15]).toBeLessThan(-0.1);
        });

        it("restores a snapshot from before the speaker was saved with the speaker low", () => {
            const { chip, scheduler } = makeAtomSoundChip();
            const snapshot = chip.snapshotState();
            delete snapshot.speakerBit;
            chip.speakerGenerator.pushBit(1, 10, 0);
            chip.restoreState(snapshot);
            chip.speakerGenerator.pushBit(1, 30, 0);
            scheduler.epoch = 40;
            const out = render(chip, 20);
            expect(out.slice(0, 15).every((v) => v === 0)).toBe(true);
            expect(out[15]).toBeGreaterThan(0.1);
        });

        it("drops the transitions it was still to play", () => {
            const { chip, scheduler } = makeAtomSoundChip();
            const snapshot = chip.snapshotState();
            chip.speakerGenerator.pushBit(1, 100, 0);
            chip.restoreState(snapshot);
            scheduler.epoch = 200;
            expect(render(chip, 100).every((v) => v === 0)).toBe(true);
        });
    });

    it("has no BBC tone channels", () => {
        const { chip, scheduler } = makeAtomSoundChip();
        const period = 100;
        for (const value of [0x80 | (period & 0x0f), period >> 4, 0x90]) chip.poke(value);
        scheduler.epoch = 64;
        expect(render(chip, 32).every((v) => Math.abs(v) < 0.01)).toBe(true);
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

    it("should carry an Atom restore's speaker level to the renderer", () => {
        const events = [];
        const scheduler = new Scheduler();
        const chip = new AtomSoundChip(() => {}, { onEvent: (event) => events.push(event) });
        chip.setScheduler(scheduler);
        const { chip: renderer } = makeAtomSoundChip();
        const out = new Float32Array(20);

        chip.updateSpeaker(true, 10, 0);
        const snapshot = chip.snapshotState();
        chip.updateSpeaker(false, 20, 0);
        for (const event of events.splice(0)) renderer.applyEvent(event);
        renderer.renderAt(0, out, 0, out.length);

        chip.restoreState(snapshot);
        chip.updateSpeaker(false, 30, 0);
        for (const event of events.splice(0)) renderer.applyEvent(event);
        renderer.renderAt(0, out, 0, out.length);
        expect(out[15]).toBeLessThan(-0.1);
    });
});

describe("InstrumentedSoundChip capture", () => {
    it("should stamp each captured write with the cycle it was made at", () => {
        const scheduler = new Scheduler();
        const chip = new InstrumentedSoundChip();
        chip.setScheduler(scheduler);
        chip.startCapture();
        scheduler.polltime(1234);
        chip.poke(0x8d);
        scheduler.polltime(10);
        chip.poke(0x07);
        expect(chip.stopCapture()).toEqual([
            { cycle: 1234, value: 0x8d },
            { cycle: 1244, value: 0x07 },
        ]);
    });
});
