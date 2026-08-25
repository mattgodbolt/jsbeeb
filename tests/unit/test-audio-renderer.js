import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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

// Drives the processor as the real system does: the producer delivers a whole
// animation frame's worth of 512-sample buffers in one burst, the consumer
// runs one 128-frame quantum at a time. Returns every effective sample rate
// the controller computed after collectAfter seconds.
function simulate(proc, seconds, { frameRateHz = 60, collectAfter = 0 } = {}) {
    const rates = [];
    const originalRate = proc._effectiveSampleRate.bind(proc);
    let simTime = 0;
    proc._effectiveSampleRate = (dt) => {
        const rate = originalRate(dt);
        if (simTime >= collectAfter) rates.push(rate);
        return rate;
    };

    const dtOut = OutputQuantum / globalThis.sampleRate;
    const outputs = [[new Float32Array(OutputQuantum)]];
    let nextBurst = 0;
    let pendingSamples = 0;
    while (simTime < seconds) {
        if (simTime >= nextBurst) {
            pendingSamples += proc.inputSampleRate / frameRateHz;
            while (pendingSamples >= 512) {
                proc.onBuffer(Date.now(), new Float32Array(512));
                pendingSamples -= 512;
            }
            nextBurst += 1 / frameRateHz;
        }
        proc.process([], outputs);
        simTime += dtOut;
    }
    proc._effectiveSampleRate = originalRate;
    return rates;
}

describe("SoundChipProcessor rate control", () => {
    it("should not modulate the playback rate with the producer's frame-rate sawtooth", () => {
        // Issue #864: the old queue-age controller carried the 60 Hz burst
        // pattern into the resampling rate at ~6.7 cents peak to peak, about
        // 2000 Hz of input-rate swing at 60 Hz. Judge the 60 Hz component
        // specifically: the total swing also contains a much slower (~15 s)
        // inaudible limit cycle from the resampler's per-quantum rounding.
        const proc = new SoundChipProcessor();
        const rates = simulate(proc, 6, { frameRateHz: 60, collectAfter: 3 });
        const controlRate = globalThis.sampleRate / OutputQuantum;
        expect(rates.length).toBeGreaterThan(1000);
        // Remove the mean and trim to whole 60 Hz cycles (25 samples at the
        // 375 Hz control rate), or the ~500 kHz DC term leaks into the bin.
        const samplesPerFourCycles = 25;
        const trimmed = rates.slice(0, Math.floor(rates.length / samplesPerFourCycles) * samplesPerFourCycles);
        const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
        const frameRateWobble = goertzelAmplitude(
            trimmed.map((r) => r - mean),
            60,
            controlRate,
        );
        expect(frameRateWobble).toBeLessThan(50);
        const peakToPeak = Math.max(...rates) - Math.min(...rates);
        expect(peakToPeak).toBeLessThan(400);
    });

    it("should speed up when the queue is over target and slow down when under", () => {
        const over = new SoundChipProcessor();
        for (let i = 0; i < Math.ceil((2 * over.startQueueSizeSamples) / 512); ++i)
            over.onBuffer(Date.now(), new Float32Array(512));
        const outputs = [[new Float32Array(OutputQuantum)]];
        for (let i = 0; i < 20; ++i) over.process([], outputs);
        expect(over._effectiveSampleRate(0)).toBeGreaterThan(over.inputSampleRate);

        const under = new SoundChipProcessor();
        for (let i = 0; i < Math.ceil(under.startQueueSizeSamples / 2 / 512); ++i)
            under.onBuffer(Date.now(), new Float32Array(512));
        under.running = true;
        for (let i = 0; i < 20; ++i) under.process([], outputs);
        expect(under._effectiveSampleRate(0)).toBeLessThan(under.inputSampleRate);
    });

    it("should converge the queue occupancy to the target", () => {
        const proc = new SoundChipProcessor();
        // Start with twice the target queued; production then matches
        // consumption, so only the controller can drain the excess.
        for (let i = 0; i < Math.ceil((2 * proc.startQueueSizeSamples) / 512); ++i)
            proc.onBuffer(Date.now(), new Float32Array(512));
        simulate(proc, 25, { frameRateHz: 60 });
        // Instantaneous occupancy rides the burst sawtooth (a whole frame's
        // samples, ~8300 peak to peak), so judge the smoothed error instead.
        expect(Math.abs(proc.smoothedOccupancyError)).toBeLessThan(proc.startQueueSizeSamples * 0.2);
        expect(proc.underruns).toBe(0);
        expect(proc.dropped).toBe(0);
    });
});
