// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TickMs } from "../../src/emulation-tick.js";
import { EmulationLoop, RunMode } from "../../src/web/emulation-loop.js";
import { domFromIndexHtml, fakeAnimationFrames, sentEvents, teardownDom, toasts } from "./helpers.js";

const ClocksPerSecond = 2000000;
// Bootstrap's stand-in for a transitionend in jsdom fires after 5 ms.
const ToastShowMs = 10;

describe("EmulationLoop", () => {
    let deps;
    let vsyncs;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
        // Move off zero: the loop uses last === 0 to mean "first tick".
        vi.advanceTimersByTime(1000);
        vsyncs = fakeAnimationFrames();
        domFromIndexHtml("leds");
        deps = {
            processor: {
                execute: vi.fn(() => true),
                stop: vi.fn(),
                pc: 0x1234,
                tapeInterface: { motorOn: false },
                fdc: { motorOn: [false, false] },
                keyboardInterface: {},
            },
            typist: { execute: (cycles) => deps.processor.execute(cycles) },
            display: {
                video: { polltime: vi.fn() },
                setSpeedy: vi.fn(),
                takePaintMs: vi.fn(() => 0),
                takePresentMs: vi.fn(() => 0),
                present: vi.fn(),
                frameSkip: 0,
            },
            audioHandler: {
                mute: vi.fn(),
                unmute: vi.fn(),
                flushChipEvents: vi.fn(),
                takeEventCounts: () => ({ leadMinMs: 1, stall: 0, skip: 0 }),
            },
            dbgr: { debug: vi.fn(), hide: vi.fn(), replacingState: vi.fn() },
            gamepad: { update: vi.fn() },
            clocksPerSecond: ClocksPerSecond,
            cpuSpeed: ClocksPerSecond,
            fastTape: false,
            audioStatsNode: null,
        };
    });

    // The loop's ticks rearm themselves, so teardownDom cannot run the timers out. A toast
    // still has to finish showing, on Bootstrap's own timer, before it can be disposed.
    afterEach(async () => {
        vi.advanceTimersByTime(ToastShowMs);
        vi.clearAllTimers();
        await teardownDom();
    });

    const make = () => new EmulationLoop(deps);
    const lockstepStub = () => ({ execute: vi.fn(() => true) });
    const cyclesExecuted = () => deps.processor.execute.mock.calls.map(([cycles]) => cycles);
    const speedIconsShown = () => ["speed-normal", "speed-turbo"].filter((id) => !document.getElementById(id).hidden);

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
        vi.advanceTimersByTime(TickMs);
        expect(cyclesExecuted()).toEqual([(10 * ClocksPerSecond) / 1000]);
        expect(deps.audioHandler.flushChipEvents).toHaveBeenCalled();
        expect(deps.gamepad.update).toHaveBeenCalledWith(deps.processor);
        expect(deps.display.takePaintMs).toHaveBeenCalled();
        expect(deps.display.setSpeedy).toHaveBeenLastCalledWith(false);
    });

    it("never emulates more than a tenth of a second in one tick", () => {
        const loop = started();
        vi.advanceTimersByTime(TickMs);
        // The page stalls for a second before the next tick gets to run.
        const afterTheStall = performance.now() + 1000;
        vi.spyOn(performance, "now").mockReturnValue(afterTheStall);
        loop.tick();
        expect(cyclesExecuted().at(-1)).toBe(ClocksPerSecond / 10);
    });

    const vsync = (time) => vsyncs.run(time);

    describe("on a vsync", () => {
        it("runs the machine up to the vsync and presents in the same callback", () => {
            started();
            vi.advanceTimersByTime(TickMs);
            const vsyncTime = performance.now() + 5;
            vi.advanceTimersByTime(7);
            vsync(vsyncTime);
            expect(cyclesExecuted().at(-1)).toBe((5 * ClocksPerSecond) / 1000);
            expect(deps.display.present).toHaveBeenCalledWith(vsyncTime);
            expect(vsyncs.pending).toBe(1);
        });

        it("times the run from when the callback ran, not from the vsync", () => {
            const loop = started();
            const update = vi.spyOn(loop.virtualSpeedUpdater, "update");
            vi.advanceTimersByTime(TickMs);
            const vsyncTime = performance.now() + 5;
            vi.advanceTimersByTime(7);
            vsync(vsyncTime);
            expect(update).toHaveBeenLastCalledWith((5 * ClocksPerSecond) / 1000, 0, false);
        });

        it("presents but emulates nothing for a vsync a timer tick has already passed", () => {
            started();
            vi.advanceTimersByTime(TickMs);
            const executed = cyclesExecuted().length;
            vsync(performance.now() - 5);
            expect(cyclesExecuted().length).toBe(executed);
            expect(deps.display.present).toHaveBeenCalledTimes(1);
        });

        it("emulates nothing while going as fast as possible", () => {
            const loop = started();
            loop.toggleFastAsPossible();
            vi.advanceTimersByTime(TickMs);
            const executed = cyclesExecuted().length;
            expect(vsyncs.pending).toBe(1);
            vsync(performance.now() + 5);
            expect(cyclesExecuted().length).toBe(executed);
        });

        it("lets go of the vsyncs once stopped", () => {
            const loop = started();
            loop.stop(false);
            vsync(performance.now() + 5);
            expect(deps.display.present).not.toHaveBeenCalled();
            expect(vsyncs.pending).toBe(0);
        });
    });

    it.each([
        ["books the next from this one's due time, so its wait is shorter", 14, 6],
        ["starts a fresh schedule when it is a whole period late", 500, 10],
    ])("after a late tick, %s", (_, lateMs, nextWaitMs) => {
        const loop = started();
        const setTimeoutSpy = vi.spyOn(window, "setTimeout");
        vi.advanceTimersByTime(TickMs);
        expect(setTimeoutSpy.mock.calls.at(-1)[1]).toBe(TickMs);
        vi.spyOn(performance, "now").mockReturnValue(performance.now() + lateMs);
        loop.tick();
        expect(setTimeoutSpy.mock.calls.at(-1)[1]).toBe(nextWaitMs);
    });

    it.each([
        ["going as fast as possible", { turbo: true }, true],
        ["fast tape with the cassette motor running", { fastTape: true, motorOn: true }, true],
        ["the cassette motor running without fast tape", { motorOn: true }, false],
    ])("runs speedy, a fiftieth of a second per tick and showing turbo, only when told: %s", (_, setup, speedy) => {
        deps.fastTape = !!setup.fastTape;
        const loop = started();
        if (setup.turbo) loop.toggleFastAsPossible();
        deps.processor.tapeInterface.motorOn = !!setup.motorOn;
        vi.advanceTimersByTime(TickMs);
        expect(cyclesExecuted().at(-1)).toBe(speedy ? ClocksPerSecond / 50 : (TickMs * ClocksPerSecond) / 1000);
        expect(deps.display.setSpeedy).toHaveBeenLastCalledWith(speedy);
        expect(speedIconsShown()).toEqual([speedy ? "speed-turbo" : "speed-normal"]);
        expect(loop.isRunning()).toBe(true);
    });

    it("names turbo's shortcut as a Mac's keyboard prints it, on a Mac", async () => {
        vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
        vi.resetModules();
        const { EmulationLoop: MacEmulationLoop } = await import("../../src/web/emulation-loop.js");
        new MacEmulationLoop(deps).toggleFastAsPossible();
        expect(toasts()).toEqual([expect.stringContaining("Turbo is on. ⌥T turns it off.")]);
    });

    it("says whether turbo is now on or off each time it is toggled, and notes each toggle", () => {
        const sent = sentEvents();
        const loop = make();
        loop.toggleFastAsPossible();
        loop.toggleFastAsPossible();
        expect(toasts()).toEqual([
            expect.stringContaining("Turbo is on. Alt-T turns it off."),
            expect.stringContaining("Turbo is off. Alt-T turns it on."),
        ]);
        expect(sent("feature_used")).toEqual([
            { feature: "turbo", action: "enter" },
            { feature: "turbo", action: "leave" },
        ]);
    });

    describe("the speed readout", () => {
        it("shows normal speed, turbo while the machine runs speedy, and normal again after", () => {
            const loop = started();
            vi.advanceTimersByTime(TickMs);
            expect(speedIconsShown()).toEqual(["speed-normal"]);
            loop.toggleFastAsPossible();
            vi.advanceTimersByTime(TickMs);
            expect(speedIconsShown()).toEqual(["speed-turbo"]);
            loop.toggleFastAsPossible();
            vi.advanceTimersByTime(TickMs);
            expect(speedIconsShown()).toEqual(["speed-normal"]);
        });
    });

    it("stops into the debugger when the processor stops itself", () => {
        const loop = started();
        deps.processor.execute.mockReturnValue(false);
        vi.advanceTimersByTime(TickMs);
        expect(loop.isRunning()).toBe(false);
        expect(deps.dbgr.debug).toHaveBeenCalledWith(0x1234);
        expect(deps.audioHandler.mute).toHaveBeenCalled();
    });

    it("notes an error the processor throws, stops into the debugger and throws it on", () => {
        const sent = sentEvents();
        const loop = started();
        const onRunning = vi.fn();
        loop.addEventListener("running", onRunning);
        deps.processor.execute.mockImplementation(() => {
            throw new Error("bad opcode");
        });
        expect(() => vi.advanceTimersByTime(TickMs)).toThrow("bad opcode");
        expect(loop.isRunning()).toBe(false);
        expect(onRunning).toHaveBeenCalledTimes(1);
        expect(deps.processor.stop).toHaveBeenCalled();
        expect(deps.audioHandler.mute).toHaveBeenCalled();
        expect(deps.dbgr.debug).toHaveBeenCalledWith(0x1234);
        expect(sent("js_error")).toEqual([expect.objectContaining({ where: "loop", message: "bad opcode" })]);
        expect(loop.mode).toBe(RunMode.debugging);
        loop.hold("the test")();
        expect(loop.isRunning()).toBe(false);
    });

    describe("the run mode", () => {
        const frame = () => vi.advanceTimersByTime(TickMs);
        const pauseNotes = (sent) => sent("feature_used").map(({ action }) => action);

        it("is stopped until first started, and follows go, stop and step", () => {
            const loop = make();
            expect(loop.mode).toBe(RunMode.stopped);
            loop.go();
            expect(loop.mode).toBe(RunMode.running);
            loop.stop(false);
            expect(loop.mode).toBe(RunMode.paused);
            loop.step();
            expect(loop.mode).toBe(RunMode.stepping);
            loop.stop(true);
            expect(loop.mode).toBe(RunMode.debugging);
        });

        it("runs one frame for a step, then is paused again, noting nothing more", () => {
            const sent = sentEvents();
            const loop = started();
            loop.stop(false);
            deps.processor.execute.mockClear();
            loop.step();
            expect(loop.isRunning()).toBe(true);
            frame();
            frame();
            frame();
            expect(cyclesExecuted()).toHaveLength(1);
            expect(loop.mode).toBe(RunMode.paused);
            expect(loop.isRunning()).toBe(false);
            expect(pauseNotes(sent)).toEqual(["enter"]);
        });

        it("stays in the debugger when a breakpoint stops a step", () => {
            const loop = started();
            loop.stop(false);
            loop.step();
            deps.processor.execute.mockReturnValue(false);
            frame();
            frame();
            expect(loop.mode).toBe(RunMode.debugging);
            expect(deps.dbgr.debug).toHaveBeenCalledWith(0x1234);
        });

        it("finishes a step a hold interrupted once the hold lets go", () => {
            const loop = started();
            loop.stop(false);
            loop.step();
            const release = loop.hold("the test");
            release();
            frame();
            frame();
            expect(loop.mode).toBe(RunMode.paused);
            expect(cyclesExecuted()).toHaveLength(1);
        });

        it("forgets a step stopped before its frame, so the next go runs freely", () => {
            const sent = sentEvents();
            const loop = started();
            loop.stop(false);
            loop.step();
            loop.stop(true);
            loop.go();
            frame();
            frame();
            frame();
            expect(loop.mode).toBe(RunMode.running);
            expect(loop.isRunning()).toBe(true);
            expect(pauseNotes(sent)).toEqual(["enter", "leave"]);
        });

        it.each([
            ["go", (loop) => loop.go()],
            ["the debugger, then go", (loop) => (loop.stop(true), loop.go())],
            ["a step, then go", (loop) => (loop.step(), frame(), frame(), loop.go())],
            ["go while held", (loop) => (loop.hold("the test"), loop.go())],
        ])("notes a pause left by %s once, and the next pause entered", (_name, leave) => {
            const sent = sentEvents();
            const loop = started();
            loop.stop(false);
            leave(loop);
            loop.stop(false);
            expect(pauseNotes(sent)).toEqual(["enter", "leave", "enter"]);
        });

        it("notes nothing for the debugger, or for pausing a paused machine again", () => {
            const sent = sentEvents();
            const loop = started();
            loop.stop(true);
            loop.go();
            loop.stop(false);
            loop.stop(false);
            expect(pauseNotes(sent)).toEqual(["enter"]);
        });

        it("shows the debugger only while debugging", () => {
            const loop = started();
            loop.stop(true);
            expect(deps.dbgr.debug).toHaveBeenCalledWith(0x1234);
            deps.dbgr.hide.mockClear();
            loop.stop(false);
            expect(deps.dbgr.hide).toHaveBeenCalled();
        });
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
        vi.advanceTimersByTime(TickMs);
        expect(cyclesExecuted()).toEqual([0]);
        vi.advanceTimersByTime(40);
        expect(cyclesExecuted().at(-1)).toBe((10 * ClocksPerSecond) / 1000);
    });

    it("ignores a lead change while stopped", () => {
        const loop = make();
        loop.setEmulationLead(50);
        expect(deps.processor.execute).not.toHaveBeenCalled();
    });

    it("announces every tick it runs the machine on", () => {
        const loop = started();
        const ticks = vi.fn();
        loop.addEventListener("tick", ticks);
        vi.advanceTimersByTime(10 * TickMs);
        expect(ticks).toHaveBeenCalledTimes(10);
    });

    it("asks for a frame capture every frame, and a rewind capture straight after every fiftieth", () => {
        const loop = started();
        const captures = [];
        loop.addEventListener("frame-capture", () => captures.push("frame"));
        loop.addEventListener("rewind-capture", () => captures.push("rewind"));
        vi.advanceTimersByTime(1500);
        expect(captures.slice(0, 52)).toEqual([...Array(50).fill("frame"), "rewind", "frame"]);
        vi.advanceTimersByTime(1000);
        expect(captures.filter((capture) => capture === "rewind")).toHaveLength(2);
    });

    it("keeps rewind captures a second of cycles apart, and frames from piling up, when ticks run long", () => {
        const loop = started();
        const captures = [];
        loop.addEventListener("frame-capture", () => captures.push("frame"));
        loop.addEventListener("rewind-capture", () => captures.push("rewind"));
        // A machine too slow for real time: every tick catches up a tenth of a second, five frames.
        const now = vi.spyOn(performance, "now");
        const start = performance.now();
        for (let tick = 1; tick <= 10; tick++) {
            now.mockReturnValue(start + 100 * tick);
            loop.tick();
        }
        expect(captures).toEqual([...Array(10).fill("frame"), "rewind"]);
        captures.length = 0;
        for (let tick = 1; tick <= 4; tick++) {
            now.mockReturnValue(start + 1000 + TickMs * tick);
            loop.tick();
        }
        expect(captures).toEqual(["frame", "frame"]);
    });

    it("starts once however often it is asked to go", () => {
        const loop = started();
        loop.go();
        expect(deps.audioHandler.unmute).toHaveBeenCalledTimes(1);
    });

    it("tells the debugger and its listeners when the machine's state is replaced", () => {
        const loop = make();
        const replacing = vi.fn();
        loop.addEventListener("replacing-state", replacing);
        loop.replacingState();
        expect(deps.dbgr.replacingState).toHaveBeenCalled();
        expect(replacing).toHaveBeenCalled();
    });

    describe("being held", () => {
        it("stops while held and runs again once let go", () => {
            const loop = started();
            const resume = loop.hold("the test");
            expect(loop.isRunning()).toBe(false);
            expect(deps.audioHandler.mute).toHaveBeenCalled();
            resume();
            expect(loop.isRunning()).toBe(true);
        });

        it("leaves the debugger's run to a stop to carry on after it", () => {
            const loop = started();
            deps.dbgr.hide.mockClear();
            loop.hold("the test")();
            expect(deps.dbgr.hide).not.toHaveBeenCalled();
            expect(deps.dbgr.replacingState).not.toHaveBeenCalled();
        });

        it("counts letting go twice as once", () => {
            const loop = started();
            const first = loop.hold("the test");
            const second = loop.hold("the test");
            first();
            first();
            expect(loop.isRunning()).toBe(false);
            second();
            expect(loop.isRunning()).toBe(true);
        });

        it("stays stopped if the user stopped it while held", () => {
            const loop = started();
            const resume = loop.hold("the test");
            loop.stop(false);
            resume();
            expect(loop.isRunning()).toBe(false);
        });

        it("waits for the hold to end before honouring a go, and says who is holding", () => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const loop = make();
            const resume = loop.hold("the test");
            loop.hold("another test");
            loop.go();
            expect(loop.isRunning()).toBe(false);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("held by the test, another test"));
            resume();
            expect(loop.isRunning()).toBe(false);
        });

        it("leaves a stopped machine stopped when let go", () => {
            const loop = make();
            loop.hold("the test")();
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
        afterEach(() => delete document.visibilityState);
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

        it("keeps running in a shared session, which would otherwise wait on this tab", () => {
            const loop = started();
            loop.setLockstep(lockstepStub());
            hide();
            expect(loop.isRunning()).toBe(true);
        });

        it("runs again when a session starts in a tab already hidden", () => {
            const loop = started();
            hide();
            loop.setLockstep(lockstepStub());
            expect(loop.isRunning()).toBe(true);
        });

        it("holds when a session ends in a hidden tab, as if the tab had been hidden with no session", () => {
            const loop = started();
            loop.setLockstep(lockstepStub());
            hide();
            loop.setLockstep(null);
            loop.setLockstep(null);
            expect(loop.isRunning()).toBe(false);
            show();
            expect(loop.isRunning()).toBe(true);
            loop.setLockstep(lockstepStub());
            loop.setLockstep(null);
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
            const resume = loop.hold("the test");
            hide();
            show();
            expect(loop.isRunning()).toBe(false);
            resume();
            expect(loop.isRunning()).toBe(true);
        });
    });

    describe("in a shared session", () => {
        let lockstep;
        beforeEach(() => {
            lockstep = lockstepStub();
        });
        const lockstepCycles = () => lockstep.execute.mock.calls.map(([cycles]) => cycles);

        it("runs the machine through the session, gamepads aside", () => {
            const loop = started();
            loop.setLockstep(lockstep);
            deps.gamepad.update.mockClear();
            vi.advanceTimersByTime(TickMs);
            loop.setEmulationLead(50);
            expect(lockstepCycles()).toEqual([(10 * ClocksPerSecond) / 1000, (50 * ClocksPerSecond) / 1000]);
            expect(cyclesExecuted()).toEqual([]);
            expect(deps.gamepad.update).not.toHaveBeenCalled();
        });

        it("never goes speedy, even with turbo on from before the session, which it shows again once it ends", () => {
            const loop = started();
            loop.toggleFastAsPossible();
            vi.advanceTimersByTime(TickMs);
            expect(speedIconsShown()).toEqual(["speed-turbo"]);
            loop.setLockstep(lockstep);
            vi.advanceTimersByTime(TickMs);
            expect(lockstepCycles().reduce((sum, cycles) => sum + cycles)).toBe((TickMs * ClocksPerSecond) / 1000);
            expect(deps.display.setSpeedy).toHaveBeenLastCalledWith(false);
            expect(speedIconsShown()).toEqual(["speed-normal"]);
            loop.setLockstep(null);
            vi.advanceTimersByTime(TickMs);
            expect(speedIconsShown()).toEqual(["speed-turbo"]);
        });

        it("refuses turbo, saying why, rather than arming it for after the session", () => {
            const sent = sentEvents();
            const loop = started();
            loop.setLockstep(lockstep);
            loop.toggleFastAsPossible();
            loop.setLockstep(null);
            expect(loop.isSpeedy()).toBe(false);
            expect(toasts()).toEqual([expect.stringContaining("not available in a shared session")]);
            expect(sent("feature_used")).toEqual([]);
        });

        it("runs the processor again once the session is over", () => {
            const loop = started();
            loop.setLockstep(lockstep);
            loop.setLockstep(null);
            vi.advanceTimersByTime(TickMs);
            expect(cyclesExecuted()).toEqual([(10 * ClocksPerSecond) / 1000]);
        });
    });

    it("does nothing once stopped, even with a tick in flight", () => {
        const loop = started();
        vi.advanceTimersByTime(TickMs);
        const executed = cyclesExecuted().length;
        loop.stop(false);
        vi.advanceTimersByTime(100);
        expect(cyclesExecuted().length).toBe(executed);
    });
});
