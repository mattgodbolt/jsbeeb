import * as utils from "../utils.js";

// A timer, not requestAnimationFrame: a display presentation stall withholds
// animation frames, and with them the sound chip's samples (issue #885).
const TickMs = 10;

export const RewindCaptureInterval = 50; // emulated frames, ~1 second

// Under ?audioDebug, one console line per second in which the emulator sat
// idle between ticks or a tick ran long, or the audio queue underran or
// dropped, so a click can be matched to a cause. The sound chip posts samples
// throughout execute(), so only the idle time starves the audio queue.
const AudioDebugLogIntervalMs = 1000;
const AudioDebugSlowTickMs = 30;
const AudioDebugSlowPresentMs = 30;

const VirtualMhzUpdateMs = 3333;

class VirtualSpeedUpdater {
    constructor(cpuSpeed) {
        this.cpuSpeed = cpuSpeed;
        this.cycles = 0;
        this.time = 0;
        this.v = document.querySelector(".virtualMHz");
        this.header = document.getElementById("virtual-mhz-header");
        this.speedy = false;
        this.display();
    }

    update(cycles, time, speedy) {
        this.cycles += cycles;
        this.time += time;
        this.speedy = speedy;
    }

    display() {
        // MRG would be nice to graph instantaneous speed to get some idea where the time goes.
        if (this.cycles) {
            const thisMHz = this.cycles / this.time / 1000;
            this.v.textContent = thisMHz.toFixed(1);
            if (this.cycles >= 10 * this.cpuSpeed) {
                this.cycles = this.time = 0;
            }
            this.header.style.color = this.speedy ? "red" : "white";
        }
        setTimeout(() => this.display(), VirtualMhzUpdateMs);
    }
}

/**
 * Runs the machine in real time: the tick that turns wall-clock time into
 * cycles, starting and stopping, the audio lead, fast-forward, rewind capture
 * and the speed readout. Owns `running`, and dispatches a "running" event
 * whenever it changes hands.
 */
export class EmulationLoop extends EventTarget {
    constructor({
        processor,
        display,
        audioHandler,
        dbgr,
        gamepad,
        keyboard,
        syncLights,
        rewindBuffer,
        onRewindCaptured,
        clocksPerSecond,
        cpuSpeed,
        fastTape,
        audioStatsNode,
    }) {
        super();
        this.processor = processor;
        this.display = display;
        this.audioHandler = audioHandler;
        this.dbgr = dbgr;
        this.gamepad = gamepad;
        this.keyboard = keyboard;
        this.syncLights = syncLights;
        this.rewindBuffer = rewindBuffer;
        this.onRewindCaptured = onRewindCaptured;
        this.clocksPerSecond = clocksPerSecond;
        this.maxCyclesPerTick = clocksPerSecond / 10;
        this.rewindCaptureCycles = (RewindCaptureInterval * clocksPerSecond) / 50;
        this.fastTape = fastTape;
        this.audioStatsNode = audioStatsNode;

        this.running = false;
        this.fastAsPossible = false;
        this.last = 0;
        this.lastEnd = 0;
        this.tickToken = null;
        this.emulationLeadMs = 0;
        this.rewindCycleCounter = 0;
        this.wasPreviouslyRunning = false;

        this.virtualSpeedUpdater = new VirtualSpeedUpdater(cpuSpeed);
        this.audioDebugLog = { start: 0, ticks: 0, cycles: 0, maxIdle: 0, maxExecute: 0, maxPaint: 0, maxSnapshot: 0 };

        document.addEventListener("visibilitychange", () => this.handleVisibilityChange(), false);
    }

    isRunning() {
        return this.running;
    }

    go() {
        this.audioHandler.unmute();
        this.running = true;
        this.dispatchEvent(new Event("running"));
        this.run();
    }

    stop(debug) {
        this.running = false;
        this.dispatchEvent(new Event("running"));
        this.processor.stop();
        if (debug) this.dbgr.debug(this.processor.pc);
        this.audioHandler.mute();
    }

    run() {
        this.scheduleTick(0);
    }

    toggleFastAsPossible() {
        this.fastAsPossible = !this.fastAsPossible;
    }

    // A user-blocking task runs ahead of rendering and ordinary timers, so a stuck
    // compositor does not hold the tick off too.
    scheduleTick(delayMs) {
        const token = (this.tickToken = {});
        const fire = () => {
            if (this.tickToken === token) this.tick();
        };
        if (window.scheduler?.postTask) window.scheduler.postTask(fire, { delay: delayMs, priority: "user-blocking" });
        else window.setTimeout(fire, delayMs);
    }

    tick() {
        if (!this.running) {
            this.last = 0;
            return;
        }
        const now = performance.now();

        const { processor, display, audioHandler } = this;
        const motorOn = processor.acia.motorOn;
        const speedy = this.fastAsPossible || (this.fastTape && motorOn);

        // In speedy mode, we still run all the state machines accurately
        // but we paint less often because painting is the most expensive
        // part of jsbeeb at this time.
        // We need need to paint per odd number of frames so that interlace
        // modes, i.e. MODE 7, still look ok.
        display.video.frameSkipCount = speedy ? 9 : 0;

        this.scheduleTick(speedy ? 0 : TickMs);

        this.gamepad.update(processor.sysvia);
        this.syncLights();
        if (this.last !== 0) {
            let cycles;
            if (!speedy) {
                const sinceLast = Math.max(0, now - this.last);
                cycles = (sinceLast * this.clocksPerSecond) / 1000;
                cycles = Math.min(cycles, this.maxCyclesPerTick);
            } else {
                cycles = this.clocksPerSecond / 50;
            }
            cycles |= 0;
            try {
                if (!processor.execute(cycles)) {
                    this.stop(true);
                }
                audioHandler.flushChipEvents();
                const end = performance.now();
                this.virtualSpeedUpdater.update(cycles, end - now, speedy);
                let snapshotMs = 0;
                this.rewindCycleCounter += cycles;
                if (this.rewindCycleCounter >= this.rewindCaptureCycles) {
                    this.rewindCycleCounter -= this.rewindCaptureCycles;
                    this.rewindBuffer.push(processor.snapshotState());
                    this.onRewindCaptured();
                    snapshotMs = performance.now() - end;
                }
                if (this.audioStatsNode)
                    this.logAudioDebugTick(
                        now,
                        cycles,
                        speedy ? 0 : now - this.lastEnd,
                        end - now,
                        display.takePaintMs(),
                        snapshotMs,
                    );
            } catch (e) {
                this.running = false;
                utils.noteEvent("exception", "thrown", e.stack);
                this.dbgr.debug(processor.pc);
                throw e;
            }
            if (this.keyboard.postFrameShouldPause()) {
                this.stop(false);
            }
        }
        this.last = Math.max(this.last, now);
        this.lastEnd = performance.now();
    }

    // A change of audio buffer depth is taken by the picture, not the sound:
    // gaining lead emulates ahead at once; losing it moves `last` forward so the
    // ticks emulate nothing until the queue has drained by that much.
    setEmulationLead(leadMs) {
        if (!this.running) return;
        const aheadMs = leadMs - this.emulationLeadMs;
        this.emulationLeadMs = leadMs;
        if (aheadMs > 0) {
            if (!this.processor.execute((aheadMs * this.clocksPerSecond) / 1000)) this.stop(true);
            this.audioHandler.flushChipEvents();
        } else {
            this.last -= aheadMs;
        }
    }

    handleVisibilityChange() {
        const { processor } = this;
        if (document.visibilityState === "hidden") {
            this.wasPreviouslyRunning = this.running;
            const keepRunningWhenHidden =
                processor.acia.motorOn || processor.fdc.motorOn[0] || processor.fdc.motorOn[1];
            if (this.running && !keepRunningWhenHidden) {
                this.stop(false);
            }
        } else {
            if (this.wasPreviouslyRunning) {
                this.go();
            }
        }
    }

    logAudioDebugTick(now, cycles, idleMs, executeMs, paintMs, snapshotMs) {
        const log = this.audioDebugLog;
        if (log.start === 0) log.start = now;
        log.ticks++;
        log.cycles += cycles;
        log.maxIdle = Math.max(log.maxIdle, idleMs);
        log.maxExecute = Math.max(log.maxExecute, executeMs);
        log.maxPaint = Math.max(log.maxPaint, paintMs);
        log.maxSnapshot = Math.max(log.maxSnapshot, snapshotMs);
        if (now - log.start < AudioDebugLogIntervalMs) return;
        const audio = this.audioHandler.takeEventCounts();
        const present = this.display.takePresentMs();
        const leadMin = Number.isFinite(audio.leadMinMs) ? `${audio.leadMinMs.toFixed(1)}ms` : "(no stats)";
        if (
            log.maxIdle > AudioDebugSlowTickMs ||
            log.maxExecute > AudioDebugSlowTickMs ||
            present > AudioDebugSlowPresentMs ||
            audio.stall ||
            audio.skip
        ) {
            console.log(
                `${(now / 1000).toFixed(0)}s: ${log.ticks} ticks emulating ${((1000 * log.cycles) / this.clocksPerSecond).toFixed(0)}ms, ` +
                    `idle max ${log.maxIdle.toFixed(0)}ms, ` +
                    `execute max ${log.maxExecute.toFixed(0)}ms (paint ${log.maxPaint.toFixed(1)}ms), ` +
                    `present max ${present.toFixed(0)}ms, snapshot ${log.maxSnapshot.toFixed(1)}ms; ` +
                    `audio lead min ${leadMin}, stalls ${audio.stall}, skipped ${audio.skip.toFixed(0)}ms`,
            );
        }
        log.start = now;
        log.ticks = log.cycles = log.maxIdle = log.maxExecute = log.maxPaint = log.maxSnapshot = 0;
    }

    benchmarkCpu(numCycles) {
        numCycles = numCycles || 10 * 1000 * 1000;
        const oldFS = this.display.frameSkip;
        this.display.frameSkip = 1000000;
        const startTime = performance.now();
        this.processor.execute(numCycles);
        const endTime = performance.now();
        this.display.frameSkip = oldFS;
        const msTaken = endTime - startTime;
        const virtualMhz = numCycles / msTaken / 1000;
        console.log("Took " + msTaken + "ms to execute " + numCycles + " cycles");
        console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
    }

    benchmarkVideo(numCycles) {
        numCycles = numCycles || 10 * 1000 * 1000;
        const oldFS = this.display.frameSkip;
        this.display.frameSkip = 1000000;
        const startTime = performance.now();
        this.display.video.polltime(numCycles);
        const endTime = performance.now();
        this.display.frameSkip = oldFS;
        const msTaken = endTime - startTime;
        const virtualMhz = numCycles / msTaken / 1000;
        console.log("Took " + msTaken + "ms to execute " + numCycles + " video cycles");
        console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
    }

    profileCpu(arg) {
        console.profile("CPU");
        this.benchmarkCpu(arg);
        console.profileEnd();
    }

    profileVideo(arg) {
        console.profile("Video");
        this.benchmarkVideo(arg);
        console.profileEnd();
    }
}
