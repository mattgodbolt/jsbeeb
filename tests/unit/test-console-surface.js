import { afterEach, describe, expect, it, vi } from "vitest";

import { exposeConsoleSurface } from "../../src/web/console-surface.js";
import { hd } from "../../src/hex.js";
import { fake6502 } from "../../src/fake6502.js";
import { romless, ViaRegister } from "./helpers.js";

const ExpectedNames = [
    "processor",
    "video",
    "soundChip",
    "go",
    "stop",
    "whoWrote",
    "hd",
    "m7dump",
    "benchmarkCpu",
    "profileCpu",
    "benchmarkVideo",
    "profileVideo",
];

const AddressEcho = { peekmem: (addr) => addr & 0xff };

function make(processor) {
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
        processor,
        video: {},
        audioHandler: { soundChip: {} },
        dbgr: { whoWrote: vi.fn() },
    };
    exposeConsoleSurface(target, deps);
    return { target, ...deps };
}

describe("exposeConsoleSurface", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        if (vi.isFakeTimers()) vi.useRealTimers();
    });

    it("defines every name the console offers", () => {
        const { target } = make(AddressEcho);
        for (const name of ExpectedNames) expect(target[name], name).toBeDefined();
    });

    it("go and stop drive the loop, and whoWrote asks the debugger", () => {
        const { target, loop, dbgr } = make(AddressEcho);
        target.go();
        expect(loop.go).toHaveBeenCalled();
        target.stop(true);
        expect(loop.stop).toHaveBeenCalledWith(true);
        target.whoWrote(0x70);
        expect(dbgr.whoWrote).toHaveBeenCalledWith(0x70);
    });

    it("exposes the machine's parts", () => {
        const { target, processor, video, audioHandler } = make(AddressEcho);
        expect(target.processor).toBe(processor);
        expect(target.video).toBe(video);
        expect(target.soundChip).toBe(audioHandler.soundChip);
    });

    it("hd logs a hex dump of memory", () => {
        const { target } = make(AddressEcho);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        target.hd(0, 16);
        expect(log).toHaveBeenCalledWith(hd((x) => x & 0xff, 0, 16));
    });

    it("m7dump logs the mode 7 screen with the top bit stripped", () => {
        const { target } = make(AddressEcho);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        target.m7dump();
        expect(log).toHaveBeenCalledWith(hd((x) => x & 0x7f, 0x7c00, 0x7fe8, { width: 40, gap: false }));
    });

    it("hd, m7dump and the processor's string and area readers only look: device state stays put and read breakpoints stay quiet", async () => {
        const processor = fake6502(romless("B-DFS1.2"));
        await processor.initialise();
        const UserVia = 0xfe60;
        const Ifr = UserVia + ViaRegister.IFR;
        const T1Flag = 0x40;
        processor.writemem(UserVia + ViaRegister.T1CL, 2);
        processor.writemem(UserVia + ViaRegister.T1CH, 0);
        processor.scheduler.polltime(100);
        expect(processor.peekmem(Ifr) & T1Flag).toBe(T1Flag);
        const hits = [];
        processor.breakpoints.onHit((hit) => hits.push(hit));
        processor.breakpoints.add({ kind: "read", start: 0x0000, end: 0xffff });

        const { target } = make(processor);
        vi.spyOn(console, "log").mockImplementation(() => {});
        target.hd(UserVia, UserVia + 0x10);
        target.m7dump();
        processor.readArea(UserVia, 0x10);
        processor.readString(UserVia);
        processor.findString("not in memory", 0);

        expect(processor.peekmem(Ifr) & T1Flag).toBe(T1Flag);
        expect(hits).toEqual([]);
    });

    it("the benchmark and profile calls are debounced onto the loop", () => {
        vi.useFakeTimers();
        const { target, loop } = make(AddressEcho);
        target.benchmarkCpu(1000);
        expect(loop.benchmarkCpu).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2);
        expect(loop.benchmarkCpu).toHaveBeenCalledWith(1000);
    });
});
