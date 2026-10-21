import { describe, expect, it } from "vitest";

import { TickMs } from "../../../src/emulation-tick.js";
import { SlicesPerSecond, timeSlices } from "../../../tools/ab-sample.js";

describe("timeSlices", () => {
    it("runs the warm-up and then the timed seconds in tick-sized slices of the model's clock", () => {
        const cyclesPerSecond = 2000000;
        const slices = [];
        const cpu = { model: { cyclesPerSecond }, execute: (cycles) => slices.push(cycles) };
        const { cycles, sliceMs } = timeSlices(cpu, { warmupSecs: 2, measureSecs: 3 });
        const sliceCycles = (cyclesPerSecond * TickMs) / 1000;
        expect(slices).toHaveLength(5 * SlicesPerSecond);
        expect(new Set(slices)).toEqual(new Set([sliceCycles]));
        expect(sliceMs).toHaveLength(3 * SlicesPerSecond);
        expect(cycles).toBe(3 * SlicesPerSecond * sliceCycles);
    });

    it("counts a fraction of a second in whole slices", () => {
        const cpu = { model: { cyclesPerSecond: 1000000 }, execute: () => {} };
        const measureSecs = 11 / SlicesPerSecond;
        expect(timeSlices(cpu, { warmupSecs: 0, measureSecs }).sliceMs).toHaveLength(11);
    });
});
