import { afterEach, describe, expect, it, vi } from "vitest";

import { exposeConsoleSurface } from "../../src/web/console-surface.js";
import * as utils from "../../src/utils.js";

// Mirrors the ConsoleSurface list in tests/playwright/smoke.spec.js.
const ExpectedNames = [
    "processor",
    "video",
    "soundChip",
    "go",
    "stop",
    "hd",
    "m7dump",
    "benchmarkCpu",
    "profileCpu",
    "benchmarkVideo",
    "profileVideo",
];

function make() {
    const target = {};
    const deps = {
        loop: {
            go: vi.fn(),
            stop: vi.fn(),
            benchmarkCpu: vi.fn(),
            profileCpu: vi.fn(),
            benchmarkVideo: vi.fn(),
            profileVideo: vi.fn(),
        },
        processor: { readmem: (addr) => addr & 0xff },
        video: {},
        audioHandler: { soundChip: {} },
    };
    exposeConsoleSurface(target, deps);
    return { target, ...deps };
}

describe("exposeConsoleSurface", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        if (vi.isFakeTimers()) vi.useRealTimers();
    });

    it("defines every name the smoke test checks for", () => {
        const { target } = make();
        for (const name of ExpectedNames) expect(target[name], name).toBeDefined();
    });

    it("go and stop drive the loop", () => {
        const { target, loop } = make();
        target.go();
        expect(loop.go).toHaveBeenCalled();
        target.stop(true);
        expect(loop.stop).toHaveBeenCalledWith(true);
    });

    it("exposes the machine's parts", () => {
        const { target, processor, video, audioHandler } = make();
        expect(target.processor).toBe(processor);
        expect(target.video).toBe(video);
        expect(target.soundChip).toBe(audioHandler.soundChip);
    });

    it("hd logs a hex dump of memory", () => {
        const { target } = make();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        target.hd(0, 16);
        expect(log).toHaveBeenCalledWith(utils.hd((x) => x & 0xff, 0, 16));
    });

    it("m7dump logs the mode 7 screen with the top bit stripped", () => {
        const { target } = make();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        target.m7dump();
        expect(log).toHaveBeenCalledWith(utils.hd((x) => x & 0x7f, 0x7c00, 0x7fe8, { width: 40, gap: false }));
    });

    it("the benchmark and profile calls are debounced onto the loop", () => {
        vi.useFakeTimers();
        const { target, loop } = make();
        target.benchmarkCpu(1000);
        expect(loop.benchmarkCpu).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2);
        expect(loop.benchmarkCpu).toHaveBeenCalledWith(1000);
    });
});
