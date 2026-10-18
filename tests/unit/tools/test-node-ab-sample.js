import { describe, expect, it } from "vitest";

import { timeSlices } from "../../../tools/node-ab-sample.js";

describe("timeSlices", () => {
    it("runs the warm-up and then the timed seconds in 10 ms slices of the model's clock", () => {
        const slices = [];
        const cpu = { model: { cyclesPerSecond: 2000000 }, execute: (cycles) => slices.push(cycles) };
        const { cycles, sliceMs } = timeSlices(cpu, { warmupSecs: 2, measureSecs: 3 });
        expect(slices).toHaveLength(500);
        expect(new Set(slices)).toEqual(new Set([20000]));
        expect(sliceMs).toHaveLength(300);
        expect(cycles).toBe(300 * 20000);
    });

    it("counts a fraction of a second in whole slices", () => {
        const cpu = { model: { cyclesPerSecond: 1000000 }, execute: () => {} };
        expect(timeSlices(cpu, { warmupSecs: 0, measureSecs: 1.1 }).sliceMs).toHaveLength(110);
    });
});
