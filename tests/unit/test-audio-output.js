import { describe, expect, it } from "vitest";

import {
    AudioOutputs,
    BoardHighPassHz,
    DefaultAudioOutput,
    OutputFilterHz,
    isAudioOutput,
    outputStages,
} from "../../src/audio-output.js";

const ChipRate = 500000;
const chainDb = (stages, hz) => 20 * Math.log10(stages.reduce((g, s) => g * s.magnitudeAt(ChipRate, hz), 1));
const relativeDb = (stages, hz, refHz = 1000) => chainDb(stages, hz) - chainDb(stages, refHz);

describe("audio output stages", () => {
    it("recognises the outputs and defaults to the speaker", () => {
        expect(Object.values(AudioOutputs).every(isAudioOutput)).toBe(true);
        expect(isAudioOutput("loud")).toBe(false);
        expect(isAudioOutput(undefined)).toBe(false);
        expect(isAudioOutput(DefaultAudioOutput)).toBe(true);
    });

    it("runs nothing when off, or when the board filter is set to zero", () => {
        expect(outputStages(ChipRate, AudioOutputs.off)).toEqual([]);
        expect(outputStages(ChipRate, AudioOutputs.board, { filterHz: 0 })).toEqual([]);
        expect(outputStages(ChipRate, AudioOutputs.speaker, { filterHz: 0 })).toEqual([]);
    });

    it("gives the board output the Sallen-Key and the coupling capacitors' corners", () => {
        const board = outputStages(ChipRate, AudioOutputs.board);
        expect(board).toHaveLength(1 + BoardHighPassHz.length);
        expect(relativeDb(board, OutputFilterHz, 2000)).toBeCloseTo(20 * Math.log10(0.696), 0);
        expect(relativeDb(board, 15625)).toBeLessThan(-12);
        expect(relativeDb(board, 122)).toBeCloseTo(-12.4, 0);
        expect(relativeDb(board, 3000)).toBeCloseTo(0, 0);
    });

    it("lets the board's low-pass be overridden, and falls back when it cannot be built", () => {
        const custom = outputStages(ChipRate, AudioOutputs.board, { filterHz: 3000, filterQ: 0.7 });
        const board = outputStages(ChipRate, AudioOutputs.board);
        expect(chainDb(custom, 3000) - chainDb(board, 3000)).toBeCloseTo(20 * Math.log10(0.7), 0);
        for (const bad of [{ filterHz: 1e6 }, { filterQ: 0 }, { filterQ: NaN }, { filterHz: NaN }]) {
            const fallback = outputStages(ChipRate, AudioOutputs.board, bad);
            expect(relativeDb(fallback, OutputFilterHz, 2000)).toBeCloseTo(20 * Math.log10(0.696), 0);
        }
    });

    it("shapes the speaker output like the measured Master, never above unity", () => {
        const speaker = outputStages(ChipRate, AudioOutputs.speaker);
        expect(relativeDb(speaker, 488)).toBeGreaterThan(4);
        expect(relativeDb(speaker, 2700)).toBeGreaterThan(6);
        expect(relativeDb(speaker, 8000)).toBeLessThan(-12);
        expect(relativeDb(speaker, 200)).toBeLessThan(-20);
        let peak = 0;
        for (let hz = 20; hz < ChipRate / 2; hz *= 1.02) peak = Math.max(peak, chainDb(speaker, hz));
        expect(peak).toBeLessThanOrEqual(0.01);
        expect(peak).toBeGreaterThan(-0.5);
    });
});
