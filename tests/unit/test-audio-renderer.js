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

// Producer delivers a frame's worth of 512-sample buffers per burst, consumer
// runs 128-frame quanta. Returns the rates computed after collectAfter seconds.
function simulate(proc, seconds, { frameRateHz = 60, collectAfter = 0 } = {}) {
    const rates = [];
    const originalRate = proc._effectiveSampleRate.bind(proc);
    let simTime = 0;
    proc._effectiveSampleRate = (dt) => {
        const rate = originalRate(dt);
        if (simTime >= collectAfter) rates.push(rate);
        return rate;
    };

    try {
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
    } finally {
        proc._effectiveSampleRate = originalRate;
    }
    return rates;
}

describe("SoundChipProcessor rate control", () => {
    it("should not modulate the playback rate with the producer's frame-rate sawtooth", () => {
        // Judge the 60 Hz component specifically: the total swing also carries the
        // startup glide as the loop settles.
        const proc = new SoundChipProcessor();
        // Start on target (half a burst below the threshold) so the loop is
        // live rather than pinned at its clamp for the whole window.
        for (let i = 0; i < Math.round(proc.startQueueSizeSamples / 2 / 512); ++i)
            proc.onBuffer(Date.now(), new Float32Array(512));
        proc.running = true;
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
        over.running = true;
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

    it("should never bend pitch audibly, however far the queue is from target", () => {
        const outputs = [[new Float32Array(OutputQuantum)]];
        const over = new SoundChipProcessor();
        over.running = true;
        for (let i = 0; i < Math.ceil((5 * over.startQueueSizeSamples) / 512); ++i)
            over.onBuffer(Date.now(), new Float32Array(512));
        for (let i = 0; i < 400; ++i) over.process([], outputs);
        expect(over._effectiveSampleRate(0)).toBeLessThanOrEqual(over.inputSampleRate + over.inputSampleRate * 0.0005);

        const under = new SoundChipProcessor();
        under.onBuffer(Date.now(), new Float32Array(512));
        under.running = true;
        for (let i = 0; i < 400; ++i) under.process([], outputs);
        expect(under._effectiveSampleRate(0)).toBeGreaterThanOrEqual(
            under.inputSampleRate - under.inputSampleRate * 0.0005,
        );
    });

    it("should consume exactly the resampling ratio, never rounding it per quantum", () => {
        // Rounding the per-quantum consumption quantises the pitch in steps of
        // one part in ~1300 (1.3 cents), audible once the rate stops jittering.
        const proc = new SoundChipProcessor();
        proc.running = true;
        for (let i = 0; i < 60; ++i) proc.onBuffer(Date.now(), new Float32Array(512));
        const outputs = [[new Float32Array(OutputQuantum)]];
        const before = proc._occupancySamples();
        let expected = 0;
        const originalRate = proc._effectiveSampleRate.bind(proc);
        proc._effectiveSampleRate = (dt) => {
            const rate = originalRate(dt);
            expected += (OutputQuantum * rate) / globalThis.sampleRate;
            return rate;
        };
        for (let i = 0; i < 20; ++i) proc.process([], outputs);
        expect(proc.underruns).toBe(0);
        expect(Math.abs(before - proc._occupancySamples() - expected)).toBeLessThan(1);
    });

    it("should converge the queue occupancy to the target", () => {
        const proc = new SoundChipProcessor();
        proc.running = true;
        for (let i = 0; i < Math.ceil(proc.startQueueSizeSamples / 512); ++i)
            proc.onBuffer(Date.now(), new Float32Array(512));
        simulate(proc, 20, { frameRateHz: 60 });
        // Instantaneous occupancy rides the burst sawtooth (a whole frame's
        // samples, ~8300 peak to peak), so judge the smoothed error instead.
        expect(Math.abs(proc.smoothedOccupancyError)).toBeLessThan(proc.startQueueSizeSamples * 0.1);
        expect(proc.underruns).toBe(0);
        expect(proc.dropped).toBe(0);
    });
});

describe("SoundChipProcessor queue trimming", () => {
    const outputs = [[new Float32Array(OutputQuantum)]];
    const fill = (proc, samples) => {
        for (let i = 0; i < Math.ceil(samples / 512); ++i) proc.onBuffer(Date.now(), new Float32Array(512));
    };
    const runDry = (proc) => {
        while (proc.running) proc.process([], outputs);
    };

    it("should not drop from a running queue that sits above target", () => {
        const proc = new SoundChipProcessor();
        proc.running = true;
        fill(proc, 3 * proc.startQueueSizeSamples);
        for (let i = 0; i < 20; ++i) proc.process([], outputs);
        expect(proc.dropped).toBe(0);
    });

    it("should trim a catch-up burst to the target when restarting after an underrun", () => {
        const proc = new SoundChipProcessor();
        fill(proc, proc.startQueueSizeSamples);
        proc.process([], outputs);
        expect(proc.running).toBe(true);
        runDry(proc);
        expect(proc.underruns).toBe(1);
        expect(proc.dropped).toBe(0);

        const target = proc.startQueueSizeSamples;
        fill(proc, 4 * target);
        proc.process([], outputs);
        expect(proc.running).toBe(true);
        const filled = Math.ceil((4 * target) / 512);
        const fewestHoldingTarget = Math.ceil(target / 512);
        expect(proc.dropped).toBe(filled - fewestHoldingTarget);
    });

    it("should only drop from a queue beyond the hard maximum", () => {
        const proc = new SoundChipProcessor();
        fill(proc, proc.maxQueueSizeSamples + 4 * 512);
        expect(proc.dropped).toBeGreaterThan(0);
        expect(proc._queueSizeSamples).toBeLessThanOrEqual(proc.maxQueueSizeSamples);
        expect(proc._queueSizeSamples).toBeGreaterThan(proc.maxQueueSizeSamples - 512);
    });
});

describe("SoundChipProcessor target latency changes", () => {
    const outputs = [[new Float32Array(OutputQuantum)]];
    const fill = (proc, samples) => {
        for (let i = 0; i < Math.ceil(samples / 512); ++i) proc.onBuffer(Date.now(), new Float32Array(512));
    };

    it("should hold the output until the queue reaches a raised target", () => {
        const proc = new SoundChipProcessor();
        const oldTarget = proc.startQueueSizeSamples;
        fill(proc, oldTarget);
        proc.process([], outputs);
        expect(proc.running).toBe(true);

        proc.setTargetLatency(10 * proc.targetLatencyMs);
        expect(proc.running).toBe(false);
        expect(proc.startQueueSizeSamples).toBe(10 * oldTarget);
        proc.process([], outputs);
        expect(proc.running).toBe(false);

        fill(proc, 10 * oldTarget);
        proc.process([], outputs);
        expect(proc.running).toBe(true);
        expect(proc.underruns).toBe(0);
    });

    it("should trim the queue at once when the target is lowered", () => {
        const proc = new SoundChipProcessor();
        proc.setTargetLatency(10 * proc.targetLatencyMs);
        const bigTarget = proc.startQueueSizeSamples;
        fill(proc, bigTarget);
        proc.process([], outputs);
        expect(proc.running).toBe(true);

        proc.setTargetLatency();
        expect(proc.running).toBe(true);
        expect(proc.dropped).toBeGreaterThan(0);
        expect(proc._occupancySamples()).toBeLessThan(proc.startQueueSizeSamples + 512);
    });
});
