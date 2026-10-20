import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const BoardSampleRate = 46875;
const BlockFrames = 128;
const Quantum = 128;
const FullScale = 32768;

let Music5000Processor;

beforeAll(async () => {
    vi.stubGlobal("sampleRate", BoardSampleRate);
    vi.stubGlobal(
        "AudioWorkletProcessor",
        class {
            constructor() {
                this.port = { postMessage() {}, onmessage: null };
            }
        },
    );
    vi.stubGlobal("registerProcessor", (name, cls) => {
        Music5000Processor = cls;
    });
    await import("../../src/music5000-worklet.js");
});

afterAll(() => {
    vi.unstubAllGlobals();
});

function makeProcessor(processorOptions) {
    const processor = new Music5000Processor({ processorOptions });
    let nextFrame = 0;
    const send = (message) => processor.port.onmessage({ data: message });
    return {
        send,
        sendBlocks(count) {
            for (let block = 0; block < count; ++block) {
                const samples = new Float64Array(BlockFrames * 2);
                for (let i = 0; i < BlockFrames; ++i) {
                    samples[2 * i] = nextFrame;
                    samples[2 * i + 1] = -nextFrame;
                    ++nextFrame;
                }
                send({ command: "samples", samples });
            }
        },
        framesSent: () => nextFrame,
        process() {
            const outputs = [[new Float32Array(Quantum), new Float32Array(Quantum)]];
            processor.process([], outputs);
            return { left: outputs[0][0], right: outputs[0][1] };
        },
    };
}

const firstFrame = ({ left }) => left[0] * FullScale;
const framesFor = (ms) => Math.ceil((BoardSampleRate * ms) / 1000);
const blocksBelow = (frames) => Math.floor(frames / BlockFrames);

describe("Music 5000 worklet", () => {
    it.each([
        ["20 ms by default", 20, undefined, () => {}],
        ["the latency it was constructed with", 40, { targetLatencyMs: 40 }, () => {}],
        [
            "a latency set after construction",
            200,
            undefined,
            (m5000) => m5000.send({ command: "setTargetLatency", targetLatencyMs: 200 }),
        ],
        ["250 ms when asked for more", 250, { targetLatencyMs: 1000 }, () => {}],
    ])("plays nothing until it has queued %s", (_, ms, processorOptions, configure) => {
        const m5000 = makeProcessor(processorOptions);
        configure(m5000);
        const target = framesFor(ms);
        m5000.sendBlocks(blocksBelow(target));
        expect(Array.from(m5000.process().left)).toEqual(new Array(Quantum).fill(0));
        m5000.sendBlocks(1);
        expect(firstFrame(m5000.process())).toBe(m5000.framesSent() - target);
    });

    it("plays the board's left and right samples on channels 0 and 1, scaled to full range", () => {
        const m5000 = makeProcessor(undefined);
        m5000.sendBlocks(blocksBelow(framesFor(20)) + 1);
        const { left, right } = m5000.process();
        const first = m5000.framesSent() - framesFor(20);
        expect(left[1]).toBe((first + 1) / FullScale);
        expect(right[1]).toBe(-(first + 1) / FullScale);
    });

    it("rejects an unknown command", () => {
        const m5000 = makeProcessor(undefined);
        expect(() => m5000.send({ command: "bogus" })).toThrow("Unknown Music 5000 command bogus");
    });

    it("skips a backlog that persists for half a second back to the target", () => {
        const m5000 = makeProcessor(undefined);
        const target = framesFor(20);
        m5000.sendBlocks(blocksBelow(target) + 1);
        m5000.process();
        m5000.sendBlocks(blocksBelow(framesFor(200)));
        const lags = [];
        for (let quantum = 0; quantum < framesFor(600) / Quantum; ++quantum) {
            m5000.sendBlocks(1);
            lags.push(m5000.framesSent() - firstFrame(m5000.process()));
        }
        expect(lags[Math.floor(framesFor(400) / Quantum)]).toBeGreaterThan(framesFor(200));
        expect(lags.at(-1)).toBe(target);
    });
});
