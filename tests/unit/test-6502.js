import { describe, it, expect, vi, afterEach } from "vitest";

import { fake6502 } from "../../src/fake6502.js";
import { FakeVideo } from "../../src/video.js";

describe("Cpu6502", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("cpuMultiplier", () => {
        const makeCpu = (cpuMultiplier) => {
            const video = new FakeVideo();
            const videoCycles = vi.spyOn(video, "polltime").mockImplementation(() => {});
            const cpu = fake6502(null, { video, cpuMultiplier });
            const totalVideoCycles = () => videoCycles.mock.calls.reduce((total, [cycles]) => total + cycles, 0);
            return { cpu, totalVideoCycles };
        };

        it("runs peripherals and video at the CPU rate by default", () => {
            const { cpu, totalVideoCycles } = makeCpu(undefined);

            cpu.polltime(1000);

            expect(cpu.scheduler.epoch).toBe(1000);
            expect(totalVideoCycles()).toBe(1000);
        });

        it("runs peripherals and video at half the CPU rate at multiplier 2", () => {
            const { cpu, totalVideoCycles } = makeCpu(2);

            cpu.polltime(1000);

            expect(cpu.scheduler.epoch).toBe(500);
            expect(totalVideoCycles()).toBe(500);
        });

        it("runs peripherals and video at twice the CPU rate at multiplier 0.5", () => {
            const { cpu, totalVideoCycles } = makeCpu(0.5);

            cpu.polltime(1000);

            expect(cpu.scheduler.epoch).toBe(2000);
            expect(totalVideoCycles()).toBe(2000);
        });

        it("takes the unscaled path at multiplier 1, passing every cycle straight through", () => {
            const { cpu } = makeCpu(1);

            cpu.polltime(1);

            expect(cpu.scheduler.epoch).toBe(1);
        });

        it("accumulates fractional peripheral cycles rather than losing them", () => {
            const { cpu } = makeCpu(2);

            cpu.polltime(1);
            expect(cpu.scheduler.epoch).toBe(0);

            cpu.polltime(1);
            expect(cpu.scheduler.epoch).toBe(1);
        });
    });
});
