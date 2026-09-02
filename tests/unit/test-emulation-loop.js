// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmulationLoop } from "../../src/web/emulation-loop.js";
import { domFromIndexHtml } from "./helpers.js";

const ClocksPerSecond = 2000000;

describe("EmulationLoop", () => {
    let deps;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
        // Move off zero: the loop uses last === 0 to mean "first tick".
        vi.advanceTimersByTime(1000);
        domFromIndexHtml("leds");
        deps = {
            processor: {
                execute: vi.fn(() => true),
                stop: vi.fn(),
                pc: 0x1234,
                acia: { motorOn: false },
                fdc: { motorOn: [false, false] },
                sysvia: {},
                snapshotState: vi.fn(() => ({})),
            },
            display: {
                video: { polltime: vi.fn() },
                setSpeedy: vi.fn(),
                takePaintMs: vi.fn(() => 0),
                takePresentMs: vi.fn(() => 0),
                frameSkip: 0,
            },
            audioHandler: {
                mute: vi.fn(),
                unmute: vi.fn(),
                flushChipEvents: vi.fn(),
                takeEventCounts: () => ({ leadMinMs: 1, stall: 0, skip: 0 }),
            },
            dbgr: { debug: vi.fn() },
            gamepad: { update: vi.fn() },
            keyboard: { postFrameShouldPause: vi.fn(() => false) },
            syncLights: vi.fn(),
            rewindBuffer: { push: vi.fn() },
            onRewindCaptured: vi.fn(),
            clocksPerSecond: ClocksPerSecond,
            cpuSpeed: ClocksPerSecond,
            fastTape: false,
            audioStatsNode: null,
        };
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    const make = () => new EmulationLoop(deps);
    const cyclesExecuted = () => deps.processor.execute.mock.calls.map(([cycles]) => cycles);

    const started = () => {
        const loop = make();
        loop.go();
        // The first tick only takes the time; the second emulates what passed.
        vi.advanceTimersByTime(0);
        return loop;
    };

    it("announces running and wakes the audio when started", () => {
        const loop = make();
        const onRunning = vi.fn(() => onRunning.runningWas.push(loop.isRunning()));
        onRunning.runningWas = [];
        loop.addEventListener("running", onRunning);
        loop.go();
        expect(deps.audioHandler.unmute).toHaveBeenCalled();
        loop.stop(false);
        expect(onRunning.runningWas).toEqual([true, false]);
        expect(deps.processor.stop).toHaveBeenCalled();
        expect(deps.audioHandler.mute).toHaveBeenCalled();
        expect(deps.dbgr.debug).not.toHaveBeenCalled();
    });

    it("turns the wall clock into cycles", () => {
        started();
        vi.advanceTimersByTime(10);
        expect(cyclesExecuted()).toEqual([(10 * ClocksPerSecond) / 1000]);
        expect(deps.audioHandler.flushChipEvents).toHaveBeenCalled();
        expect(deps.gamepad.update).toHaveBeenCalledWith(deps.processor.sysvia);
        expect(deps.syncLights).toHaveBeenCalled();
        expect(deps.display.takePaintMs).toHaveBeenCalled();
        expect(deps.display.setSpeedy).toHaveBeenLastCalledWith(false);
    });

    it("never emulates more than a tenth of a second in one tick", () => {
        const loop = started();
        vi.advanceTimersByTime(10);
        // The page stalls for a second before the next tick gets to run.
        const afterTheStall = performance.now() + 1000;
        vi.spyOn(performance, "now").mockReturnValue(afterTheStall);
        loop.tick();
        expect(cyclesExecuted().at(-1)).toBe(ClocksPerSecond / 10);
    });

    it("runs a fiftieth of a second per tick when going as fast as possible", () => {
        const loop = started();
        loop.toggleFastAsPossible();
        vi.advanceTimersByTime(10);
        expect(cyclesExecuted().at(-1)).toBe(ClocksPerSecond / 50);
        expect(deps.display.setSpeedy).toHaveBeenLastCalledWith(true);
    });

    it("speeds up for a tape motor only when told fast tape", () => {
        deps.fastTape = true;
        const loop = started();
        deps.processor.acia.motorOn = true;
        vi.advanceTimersByTime(10);
        expect(cyclesExecuted().at(-1)).toBe(ClocksPerSecond / 50);
        expect(loop.isRunning()).toBe(true);
    });

    it("stops into the debugger when the processor stops itself", () => {
        const loop = started();
        deps.processor.execute.mockReturnValue(false);
        vi.advanceTimersByTime(10);
        expect(loop.isRunning()).toBe(false);
        expect(deps.dbgr.debug).toHaveBeenCalledWith(0x1234);
        expect(deps.audioHandler.mute).toHaveBeenCalled();
    });

    it("pauses when the keyboard asks after a frame", () => {
        const loop = started();
        deps.keyboard.postFrameShouldPause.mockReturnValue(true);
        vi.advanceTimersByTime(10);
        expect(loop.isRunning()).toBe(false);
        expect(deps.dbgr.debug).not.toHaveBeenCalled();
    });

    it("emulates ahead at once when the audio queue deepens", () => {
        const loop = started();
        loop.setEmulationLead(50);
        expect(cyclesExecuted()).toEqual([(50 * ClocksPerSecond) / 1000]);
        expect(deps.audioHandler.flushChipEvents).toHaveBeenCalled();
    });

    it("emulates nothing until a shallower queue has drained", () => {
        const loop = started();
        loop.setEmulationLead(50);
        deps.processor.execute.mockClear();
        loop.setEmulationLead(20);
        expect(deps.processor.execute).not.toHaveBeenCalled();
        // The 30ms handed back come out of the next ticks' budget.
        vi.advanceTimersByTime(10);
        expect(cyclesExecuted()).toEqual([0]);
        vi.advanceTimersByTime(40);
        expect(cyclesExecuted().at(-1)).toBe((10 * ClocksPerSecond) / 1000);
    });

    it("ignores a lead change while stopped", () => {
        const loop = make();
        loop.setEmulationLead(50);
        expect(deps.processor.execute).not.toHaveBeenCalled();
    });

    it("captures a rewind snapshot every interval", () => {
        started();
        // The capture interval is one emulated second.
        vi.advanceTimersByTime(1500);
        expect(deps.rewindBuffer.push).toHaveBeenCalledTimes(1);
        expect(deps.onRewindCaptured).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        expect(deps.rewindBuffer.push).toHaveBeenCalledTimes(2);
    });

    it("starts once however often it is asked to go", () => {
        const loop = started();
        loop.go();
        expect(deps.audioHandler.unmute).toHaveBeenCalledTimes(1);
    });

    describe("being held", () => {
        it("stops while held and runs again once let go", () => {
            const loop = started();
            const resume = loop.pause("the test");
            expect(loop.isRunning()).toBe(false);
            expect(deps.audioHandler.mute).toHaveBeenCalled();
            resume();
            expect(loop.isRunning()).toBe(true);
        });

        it("runs again only when the last hold has let go", () => {
            const loop = started();
            const first = loop.pause("the test");
            const second = loop.pause("the test");
            first();
            expect(loop.isRunning()).toBe(false);
            second();
            expect(loop.isRunning()).toBe(true);
        });

        it("counts letting go twice as once", () => {
            const loop = started();
            const first = loop.pause("the test");
            const second = loop.pause("the test");
            first();
            first();
            expect(loop.isRunning()).toBe(false);
            second();
            expect(loop.isRunning()).toBe(true);
        });

        it("stays stopped if the user stopped it while held", () => {
            const loop = started();
            const resume = loop.pause("the test");
            loop.stop(false);
            resume();
            expect(loop.isRunning()).toBe(false);
        });

        it("waits for the hold to end before honouring a go, and says who is holding", () => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const loop = make();
            const resume = loop.pause("the test");
            loop.pause("another test");
            loop.go();
            expect(loop.isRunning()).toBe(false);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("held by the test, another test"));
            resume();
            expect(loop.isRunning()).toBe(false);
        });

        it("leaves a stopped machine stopped when let go", () => {
            const loop = make();
            loop.pause("the test")();
            expect(loop.isRunning()).toBe(false);
            expect(deps.audioHandler.unmute).not.toHaveBeenCalled();
        });
    });

    describe("a hidden tab", () => {
        let visibility;
        beforeEach(() => {
            visibility = "visible";
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
        });
        const hide = () => {
            visibility = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
        };
        const show = () => {
            visibility = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
        };

        it("pauses while hidden and resumes on return", () => {
            const loop = started();
            hide();
            expect(loop.isRunning()).toBe(false);
            show();
            expect(loop.isRunning()).toBe(true);
        });

        it("keeps running while a motor is on", () => {
            const loop = started();
            deps.processor.fdc.motorOn[0] = true;
            hide();
            expect(loop.isRunning()).toBe(true);
        });

        it("stays stopped on return when it was stopped before", () => {
            const loop = started();
            loop.stop(false);
            hide();
            show();
            expect(loop.isRunning()).toBe(false);
        });

        it("stays held for whoever else is holding it when the tab comes back", () => {
            const loop = started();
            const resume = loop.pause("the test");
            hide();
            show();
            expect(loop.isRunning()).toBe(false);
            resume();
            expect(loop.isRunning()).toBe(true);
        });
    });

    it("does nothing once stopped, even with a tick in flight", () => {
        const loop = started();
        vi.advanceTimersByTime(10);
        const executed = cyclesExecuted().length;
        loop.stop(false);
        vi.advanceTimersByTime(100);
        expect(cyclesExecuted().length).toBe(executed);
    });
});
