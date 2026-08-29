import { describe, expect, it } from "vitest";

import { analyseCapture, basicSource, buildSchedule, buildSsd, toneHz } from "../../tools/audio-sweep.js";

const Rate = 48000;
const LeadSeconds = 1.5;
const ClockRatio = 1.0002;
const FullVolume = 0.25;

/** A capture of the schedule as an ideal chip would play it: square-wave tones, sine marker bursts. */
function synthesiseCapture(schedule) {
    const csToSamples = (cs) => Math.round((cs / 100) * Rate * ClockRatio);
    const lead = Math.round(LeadSeconds * Rate);
    const samples = new Float64Array(lead + csToSamples(schedule.totalCs + 300));
    const render = (startCs, durationCs, period, amplitude, shape) => {
        const hz = toneHz(period) / ClockRatio;
        const from = lead + csToSamples(startCs);
        const to = lead + csToSamples(startCs + durationCs);
        for (let i = from; i < to; ++i) {
            const phase = ((i - from) * hz) / Rate;
            samples[i] += amplitude * shape(phase);
        }
    };
    const square = (phase) => (phase % 1 < 0.5 ? 1 : -1);
    const sine = (phase) => Math.sin(2 * Math.PI * phase);
    for (const segment of schedule.segments) {
        if (segment.kind === "marker") {
            for (let burst = 0; burst < 3; ++burst)
                render(segment.start + burst * 20, 10, segment.period, FullVolume, sine);
        } else if (segment.kind === "tone" || segment.kind === "staircase") {
            const amplitude = segment.attenuation === 15 ? 0 : FullVolume * 10 ** (-0.1 * segment.attenuation);
            render(segment.start, segment.duration, segment.period, amplitude, square);
        }
    }
    return samples;
}

describe("audio sweep schedule", () => {
    const schedule = buildSchedule();

    it("writes register bytes in time order", () => {
        let last = 0;
        for (const { t, bytes } of schedule.events) {
            expect(t).toBeGreaterThanOrEqual(last);
            last = t;
            expect(bytes[0]).toBeGreaterThanOrEqual(0x80);
            for (const b of bytes) expect(b).toBeLessThan(0x100);
        }
        expect(schedule.segments[0]).toMatchObject({ kind: "marker", label: "start", start: 0 });
        expect(schedule.segments.at(-1)).toMatchObject({ kind: "marker", label: "end" });
        expect(schedule.totalCs).toBeLessThan(100 * 90);
    });

    it("covers the audio band a quarter octave at a time", () => {
        const periods = schedule.segments.filter((s) => s.kind === "tone" && s.attenuation === 0).map((s) => s.period);
        expect(periods[0]).toBe(1023);
        expect(periods.at(-1)).toBeLessThanOrEqual(6);
        for (let i = 1; i < periods.length; ++i) {
            const ratio = periods[i - 1] / periods[i];
            expect(ratio).toBeGreaterThan(1);
            expect(ratio).toBeLessThan(2 ** 0.5);
        }
    });

    it("emits BASIC lines that fit and end the data with a sentinel", () => {
        const lines = basicSource(schedule).trimEnd().split("\n");
        for (const line of lines) expect(line.length).toBeLessThan(240);
        expect(lines.at(-1)).toMatch(/DATA .*,-1$/);
        expect(lines.filter((l) => /DATA/.test(l)).join(",")).toContain(`${schedule.totalCs},4,&9F,&BF,&DF,&FF`);
    });
});

describe("audio sweep disc image", () => {
    it("catalogues the files with an EXEC boot option", () => {
        const boot = Uint8Array.from("*BASIC\r", (c) => c.charCodeAt(0));
        const program = new Uint8Array(700).fill(0x42);
        const image = buildSsd([
            { name: "!BOOT", load: 0, exec: 0, data: boot },
            { name: "SWEEP", load: 0xffff1900, exec: 0xffff8023, data: program },
        ]);
        expect(image.length).toBe(80 * 10 * 256);
        expect(image[256 + 5]).toBe(16);
        expect(image[256 + 6] >> 4).toBe(3);
        const name = (entry) => String.fromCharCode(...image.subarray(8 + entry * 8, 15 + entry * 8)).trim();
        expect(name(0)).toBe("SWEEP");
        expect(name(1)).toBe("!BOOT");
        const entry = 256 + 8;
        const length = image[entry + 4] | (image[entry + 5] << 8) | (((image[entry + 6] >> 4) & 3) << 16);
        const startSector = image[entry + 7] | ((image[entry + 6] & 3) << 8);
        expect(length).toBe(700);
        expect(startSector).toBe(3);
        expect(image[entry] | (image[entry + 1] << 8)).toBe(0x1900);
        expect(image[entry + 2] | (image[entry + 3] << 8)).toBe(0x8023);
        expect(image[entry + 6] >> 6).toBe(3);
        expect(image.subarray(3 * 256, 3 * 256 + 700)).toEqual(program);
        expect(image.subarray(2 * 256, 2 * 256 + boot.length)).toEqual(boot);
    });
});

describe("audio sweep analysis", () => {
    const schedule = buildSchedule();
    const analysis = analyseCapture(synthesiseCapture(schedule), Rate, schedule);
    const tones = analysis.results.filter((r) => r.kind === "tone" && !r.aboveNyquist);

    it("finds the markers and the clock ratio", () => {
        expect(analysis.start / Rate).toBeCloseTo(LeadSeconds, 2);
        expect(analysis.startQuality).toBeGreaterThan(0.8);
        expect(analysis.clockRatio).toBeCloseTo(ClockRatio, 4);
    });

    it("measures each tone's fundamental and harmonics", () => {
        const dB = (v) => 20 * Math.log10(v);
        for (const tone of tones) {
            const expected = (FullVolume * 10 ** (-0.1 * tone.attenuation) * 4) / Math.PI;
            expect(Math.abs(dB(tone.harmonics[0] / expected))).toBeLessThan(0.15);
            if (tone.harmonics[2] !== null) expect(dB(tone.harmonics[2] / tone.harmonics[0])).toBeCloseTo(-9.54, 0);
            if (tone.harmonics[1] !== null) expect(dB(tone.harmonics[1] / tone.harmonics[0])).toBeLessThan(-40);
        }
        expect(tones.length).toBeGreaterThan(50);
    });

    it("reads the volume staircase as 2 dB steps", () => {
        const levels = analysis.results.filter((r) => r.kind === "staircase").map((r) => r.harmonics[0]);
        for (let i = 1; i < 15; ++i) expect(20 * Math.log10(levels[i] / levels[i - 1])).toBeCloseTo(-2, 1);
        expect(levels[15]).toBeLessThan(1e-6);
    });
});
