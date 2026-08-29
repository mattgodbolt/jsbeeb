import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { SoundChip } from "../../src/soundchip.js";

// audio-renderer.js reads AudioWorklet globals at import time, so stub them
// before dynamically importing it.
let SoundChipProcessor;

beforeAll(async () => {
    vi.stubGlobal("sampleRate", 48000);
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal(
        "AudioWorkletProcessor",
        class {
            constructor() {
                this.port = { postMessage() {}, onmessage: null };
            }
        },
    );
    vi.stubGlobal("registerProcessor", (name, cls) => {
        SoundChipProcessor = cls;
    });
    await import("../../src/web/audio-renderer.js");
});

afterAll(() => {
    vi.unstubAllGlobals();
});

const OutputQuantum = 128;
const OutputRate = 48000;
const CyclesPerMs = 2000;
const CyclesPerSample = 4; // 2MHz CPU, 500kHz chip

// SN76489 writes for a 1kHz tone on channel 0 at full volume: 4MHz / (32 * 125).
const TonePeriod = 125;
const ToneHz = 4000000 / (32 * TonePeriod);
const toneWrites = (period) => [0x80 | (period & 0x0f), period >> 4, 0x90];
const ToneOn = toneWrites(TonePeriod);
const ToneOff = [0x9f];

// A 1250 Hz tone's 39th harmonic folds about the output rate to a frequency
// no real harmonic occupies; only a filter ahead of the resampler can touch it.
const AliasTonePeriod = 100;
const AliasToneHz = 4000000 / (32 * AliasTonePeriod);
const FoldedSpurHz = 39 * AliasToneHz - OutputRate;

// Sample playback parks a channel on an ultrasonic carrier and modulates its
// volume; period 4 is the usual choice, 31.25 kHz.
const SampledSoundCarrierPeriod = 4;
const SampledSoundCarrierHz = 4000000 / (32 * SampledSoundCarrierPeriod);

// 6250 Hz: its third harmonic sits where the board's filter has bitten hard.
const HighTonePeriod = 20;
const HighToneHz = 4000000 / (32 * HighTonePeriod);

// Amplitude of the frequency-bin component at freq, via the Goertzel algorithm.
function goertzelAmplitude(samples, freq, rate) {
    const w = (2 * Math.PI * freq) / rate;
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

// Stands in for the main thread: a chip that emits events, an epoch that
// advances with emulated time, and a flush that ships both to the worklet.
function makeProducer(proc) {
    const events = [];
    const chip = new SoundChip(null, { onEvent: (event) => events.push(event) });
    return {
        chip,
        get epoch() {
            return chip.scheduler.epoch;
        },
        poke(...values) {
            for (const value of values) chip.poke(value);
        },
        advance(ms) {
            chip.scheduler.epoch += ms * CyclesPerMs;
        },
        flush() {
            proc.onProduced(chip.scheduler.epoch, events.splice(0));
        },
    };
}

const quantum = (proc) => {
    const outputs = [[new Float32Array(OutputQuantum)]];
    proc.process([], outputs);
    return outputs[0][0];
};

// Producer ticks every tickMs of simulated time, consumer runs 128-frame
// quanta. Returns the effective rates and output collected after collectAfter.
// nominalRate pins the resampling ratio, for spectral measurements.
function simulate(
    proc,
    producer,
    seconds,
    { tickMs = 10, collectAfter = 0, ticking = () => true, nominalRate = false } = {},
) {
    const rates = [];
    const output = [];
    const originalRate = proc._effectiveSampleRate.bind(proc);
    let simTime = 0;
    proc._effectiveSampleRate = (dt) => {
        const rate = nominalRate ? proc.inputSampleRate : originalRate(dt);
        if (simTime >= collectAfter) rates.push(rate);
        return rate;
    };
    try {
        const dtOut = OutputQuantum / OutputRate;
        let nextTick = 0;
        while (simTime < seconds) {
            if (simTime >= nextTick) {
                if (ticking(simTime)) {
                    producer.advance(tickMs);
                    producer.flush();
                }
                nextTick += tickMs / 1000;
            }
            const out = quantum(proc);
            if (simTime >= collectAfter) output.push(...out);
            simTime += dtOut;
        }
    } finally {
        proc._effectiveSampleRate = originalRate;
    }
    return { rates, output };
}

// A processor already running with a target's lead, playing the test tone.
function startedWithTone(proc, writes = ToneOn) {
    const producer = makeProducer(proc);
    producer.poke(...writes);
    producer.advance(proc.targetLatencyMs);
    producer.flush();
    quantum(proc);
    expect(proc.stalled).toBe(false);
    return producer;
}

// The speaker output is several dB down at the test tone, so the rendering
// and timing tests, which only care about the tone being there, use the board's.
const BoardOutput = { processorOptions: { audioOutput: "board" } };

describe("SoundChipProcessor rendering", () => {
    it("should render the chip's tone from its register writes", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        const { output } = simulate(proc, producer, 0.5, { collectAfter: 0.1 });
        expect(goertzelAmplitude(output, ToneHz, OutputRate)).toBeGreaterThan(0.1);
        expect(goertzelAmplitude(output, ToneHz * 1.5, OutputRate)).toBeLessThan(0.02);
    });

    const spectralLine = (options, writes, hz) => {
        const proc = new SoundChipProcessor({ processorOptions: { audioOutput: "board", ...options } });
        const producer = startedWithTone(proc, writes);
        const { output } = simulate(proc, producer, 0.5, { collectAfter: 0.1, nominalRate: true });
        return goertzelAmplitude(output, hz, OutputRate);
    };

    it("should not fold a harmonic from above the output rate into the audible band", () => {
        const writes = toneWrites(AliasTonePeriod);
        const fundamental = spectralLine({}, writes, AliasToneHz);
        expect(fundamental).toBeGreaterThan(0.1);
        expect(spectralLine({}, writes, FoldedSpurHz)).toBeLessThan(fundamental / 3000);
        expect(spectralLine({ audioFilterFreq: 0 }, writes, FoldedSpurHz)).toBeLessThan(fundamental / 3000);
    });

    it("should not fold the carrier of sampled sound into the audible band", () => {
        const writes = toneWrites(SampledSoundCarrierPeriod);
        const folded = spectralLine({ audioFilterFreq: 0 }, writes, OutputRate - SampledSoundCarrierHz);
        expect(folded).toBeLessThan(1e-4);
    });

    it("should apply the board's filter at the chip rate, ahead of the resampler", () => {
        const writes = toneWrites(HighTonePeriod);
        const harmonic = 3 * HighToneHz;
        const unfiltered = spectralLine({ audioFilterFreq: 0 }, writes, harmonic);
        expect(unfiltered).toBeGreaterThan(0.01);
        expect(spectralLine({}, writes, harmonic)).toBeLessThan(unfiltered / 4);
    });

    it("should switch outputs on request, and run the speaker's shaping on top of the board's", () => {
        const writes = toneWrites(HighTonePeriod);
        const harmonic = 3 * HighToneHz;
        const off = spectralLine({ audioOutput: "off" }, writes, harmonic);
        const board = spectralLine({ audioOutput: "board" }, writes, harmonic);
        const speaker = spectralLine({ audioOutput: "speaker" }, writes, harmonic);
        expect(board).toBeLessThan(off / 4);
        expect(speaker).toBeLessThan(board / 4);

        const proc = new SoundChipProcessor({ processorOptions: { audioOutput: "off" } });
        const producer = startedWithTone(proc, writes);
        proc.port.onmessage({ data: { command: "setAudioOutput", audioOutput: "board" } });
        const { output } = simulate(proc, producer, 0.5, { collectAfter: 0.1, nominalRate: true });
        expect(goertzelAmplitude(output, harmonic, OutputRate)).toBeLessThan(off / 4);
    });

    it("should only rebuild the chain for an amount that matters", () => {
        const proc = new SoundChipProcessor({ processorOptions: { audioOutput: "board" } });
        const before = proc.outputFilters;
        proc.port.onmessage({ data: { command: "setSpeakerAmount", speakerAmount: 0.5 } });
        expect(proc.outputFilters).toBe(before);
        proc.port.onmessage({ data: { command: "setAudioOutput", audioOutput: "speaker" } });
        const speaker = proc.outputFilters;
        proc.port.onmessage({ data: { command: "setSpeakerAmount", speakerAmount: 0.5 } });
        expect(proc.outputFilters).toBe(speaker);
        proc.port.onmessage({ data: { command: "setSpeakerAmount", speakerAmount: 0.25 } });
        expect(proc.outputFilters).not.toBe(speaker);
    });

    it("should fall back to the board's filter when the settings cannot be realised", () => {
        for (const options of [{ audioFilterQ: 0 }, { audioFilterQ: NaN }, { audioFilterFreq: 1e6 }]) {
            const proc = new SoundChipProcessor({ processorOptions: { audioOutput: "board", ...options } });
            const producer = startedWithTone(proc);
            const { output } = simulate(proc, producer, 0.3, { collectAfter: 0.1 });
            expect(output.every(Number.isFinite)).toBe(true);
            expect(goertzelAmplitude(output, ToneHz, OutputRate)).toBeGreaterThan(0.1);
        }
    });

    it("should apply a write at its cycle, part way through a quantum", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        const rendered = new Float32Array(1000);
        // The tone goes quiet at a cycle in the middle of the samples rendered.
        const offCycle = proc.clock + 500 * CyclesPerSample;
        producer.chip.scheduler.epoch = offCycle;
        producer.poke(...ToneOff);
        producer.advance(10);
        producer.flush();
        proc._renderInput(rendered, 0, rendered.length);
        const loud = rendered.subarray(0, 500);
        const quiet = rendered.subarray(520, 1000);
        expect(Math.max(...loud) - Math.min(...loud)).toBeGreaterThan(0.1);
        expect(Math.max(...quiet) - Math.min(...quiet)).toBeLessThan(0.01);
    });

    it("should keep sounding the current state when the producer stalls, then skip the stalled time", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        // The producer stops for 100ms of the consumer's time, then resumes at
        // real-time rate: the lead drains, time stands still, and once the
        // producer is a target ahead again nothing needs skipping.
        simulate(proc, producer, 0.3, { ticking: (t) => !(t > 0.1 && t < 0.2) });
        expect(proc.stalls).toBe(1);
        expect(proc.stalled).toBe(false);
        expect(proc.skippedMs).toBeLessThan(1);
    });

    it("should skip the missed time when the producer catches up in one burst", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        for (let i = 0; i < 200; ++i) quantum(proc);
        expect(proc.stalled).toBe(true);
        producer.advance(100);
        producer.flush();
        quantum(proc);
        expect(proc.stalled).toBe(false);
        expect(proc.skippedMs).toBeCloseTo(100 - proc.targetLatencyMs, 0);
    });

    it("should carry on with the tone, not silence, while stalled", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        startedWithTone(proc);
        // No more production: the lead drains, then the chip is held.
        const output = [];
        for (let i = 0; i < 200; ++i) output.push(...quantum(proc));
        expect(proc.stalled).toBe(true);
        const held = output.slice(output.length - 2000);
        expect(goertzelAmplitude(held, ToneHz, OutputRate)).toBeGreaterThan(0.1);
    });

    it("should be in the producer's state after skipping, having applied the writes it skipped", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        for (let i = 0; i < 200; ++i) quantum(proc);
        expect(proc.stalled).toBe(true);
        producer.advance(50);
        producer.poke(...ToneOff);
        producer.advance(50);
        producer.flush();
        quantum(proc);
        expect(proc.stalled).toBe(false);
        expect(proc.leadMs()).toBeLessThanOrEqual(proc.targetLatencyMs);
        expect(proc.leadMs()).toBeGreaterThan(proc.targetLatencyMs - 3);
        const output = [];
        for (let i = 0; i < 40; ++i) output.push(...quantum(proc));
        expect(goertzelAmplitude(output.slice(1000), ToneHz, OutputRate)).toBeLessThan(0.01);
    });

    it("should jump to a restored state's timeline and discard what came before it", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        const state = producer.chip.snapshotState();
        producer.poke(...ToneOff);
        // A rewind: the epoch goes backwards and the chip is restored.
        producer.chip.scheduler.epoch = 1000;
        producer.chip.restoreState(state);
        producer.advance(proc.targetLatencyMs);
        producer.flush();
        quantum(proc);
        expect(proc.clock).toBeGreaterThanOrEqual(1000);
        expect(proc.clock).toBeLessThan(1000 + proc.targetLatencyMs * CyclesPerMs);
        const output = [];
        for (let i = 0; i < 10; ++i) output.push(...quantum(proc));
        expect(goertzelAmplitude(output, ToneHz, OutputRate)).toBeGreaterThan(0.1);
    });
});

describe("SoundChipProcessor rate control", () => {
    it("should not modulate the playback rate at the producer's tick rate", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        const { rates } = simulate(proc, producer, 3, { collectAfter: 2 });
        const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
        const wobble = goertzelAmplitude(
            rates.map((r) => r - mean),
            100,
            OutputRate / OutputQuantum,
        );
        expect(wobble).toBeLessThan(50);
        expect(Math.max(...rates) - Math.min(...rates)).toBeLessThan(400);
        expect(proc.stalls).toBe(0);
    });

    it("should speed up when the lead is over target and slow down when under", () => {
        const over = new SoundChipProcessor(BoardOutput);
        const overProducer = startedWithTone(over);
        overProducer.advance(3 * over.targetLatencyMs);
        overProducer.flush();
        for (let i = 0; i < 20; ++i) quantum(over);
        expect(over._effectiveSampleRate(0)).toBeGreaterThan(over.inputSampleRate);

        const under = new SoundChipProcessor(BoardOutput);
        startedWithTone(under);
        for (let i = 0; i < 3; ++i) quantum(under);
        expect(under._effectiveSampleRate(0)).toBeLessThan(under.inputSampleRate);
    });

    it("should never bend pitch audibly, however far the lead is from target", () => {
        const over = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(over);
        producer.advance(20 * over.targetLatencyMs);
        producer.flush();
        for (let i = 0; i < 400; ++i) quantum(over);
        expect(over._effectiveSampleRate(0)).toBeLessThanOrEqual(over.inputSampleRate + over.inputSampleRate * 0.0005);

        const under = new SoundChipProcessor(BoardOutput);
        startedWithTone(under);
        for (let i = 0; i < 400; ++i) quantum(under);
        expect(under._effectiveSampleRate(0)).toBeGreaterThanOrEqual(
            under.inputSampleRate - under.inputSampleRate * 0.0005,
        );
    });

    it("should converge the lead to the target without stalling", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        simulate(proc, producer, 20);
        expect(Math.abs(proc.smoothedLeadError)).toBeLessThan(proc.targetLeadCycles * 0.1);
        expect(proc.stalls).toBe(0);
    });
});

describe("SoundChipProcessor target latency", () => {
    it("should fall back to the default for a missing, zero or non-numeric target", () => {
        const fallback = new SoundChipProcessor(BoardOutput).targetLatencyMs;
        for (const targetLatencyMs of [undefined, 0, -5, NaN, Infinity, "abc"]) {
            const proc = new SoundChipProcessor({ processorOptions: { targetLatencyMs } });
            expect(proc.targetLatencyMs).toBe(fallback);
        }
        expect(new SoundChipProcessor({ processorOptions: { targetLatencyMs: 35 } }).targetLatencyMs).toBe(35);
    });

    it("should cap the target and keep playing through a change of it", () => {
        const proc = new SoundChipProcessor(BoardOutput);
        const producer = startedWithTone(proc);
        proc.setTargetLatency(100000);
        expect(proc.targetLatencyMs).toBeLessThanOrEqual(250);
        proc.setTargetLatency(2 * proc.targetLatencyMs);
        quantum(proc);
        expect(proc.stalled).toBe(false);
        producer.advance(100);
        producer.flush();
        proc.setTargetLatency();
        quantum(proc);
        expect(proc.stalled).toBe(false);
        expect(proc.skippedMs).toBe(0);
    });
});
