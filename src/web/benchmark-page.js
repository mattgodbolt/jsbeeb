import { checkWorkload, readWorkload, restoreWorkload } from "../benchmark-workloads.js";
import { TickMs } from "../emulation-tick.js";
import { isSameModel } from "../snapshot.js";
import { FakeVideo } from "../video.js";

export const WarmupSeconds = 5;
export const Repeats = 10;
const ChunksPerSecond = 1000 / TickMs;
const DialogId = "benchmark";
// Each changes what a pass measures or what an emulated second is.
const MeasureChangingParams = ["fakeVideo", "frameSkip", "cpuMultiplier", "videoCyclesBatch", "lowLatency"];

const fixed = (value) => value.toFixed(1);
const noPaint = () => {};
const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

function quantile(sorted, fraction) {
    const position = (sorted.length - 1) * fraction;
    const below = Math.floor(position);
    const above = Math.min(below + 1, sorted.length - 1);
    return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/**
 * The median, min and quartiles of `values` (the quartiles interpolated between the closest ranks), and its
 * first and last, in the order they were taken.
 * @param {number[]} values
 */
export function summarise(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        median: quantile(sorted, 0.5),
        min: sorted[0],
        q1: quantile(sorted, 0.25),
        q3: quantile(sorted, 0.75),
        first: values[0],
        last: values.at(-1),
    };
}

const describeSummary = (name, { median, min, q1, q3, first, last }) =>
    `${name} ${fixed(median)} [min ${fixed(min)}, IQR ${fixed(q1)}-${fixed(q3)}, first ${fixed(first)}, last ${fixed(last)}]`;

/**
 * Why the page's machine is not the one the workload runs on: each of the workload's fittings that `takenFromHost`
 * (the page's, see takenFromHostValues) has otherwise, or null if none.
 * @param {object} workload a manifest entry
 * @param {object} takenFromHost
 * @returns {string|null}
 */
export function misfitting({ name, fittings }, takenFromHost) {
    const wanted = Object.entries(fittings)
        .filter(([fitting, value]) => takenFromHost[fitting] !== value)
        .map(([fitting, value]) => `${fitting}=${value}`);
    if (!wanted.length) return null;
    return `The ${name} workload runs with ${wanted.join(", ")}; set ${wanted.length > 1 ? "those" : "that"} in the URL`;
}

/** The one line a person pastes: every figure in `result`, in ms of wall time per emulated second. */
export function resultLine(result) {
    const { workload, model, mhz, passes, split, repeats, warmupSeconds } = result;
    const summaries = Object.entries(passes).map(([name, pass]) => describeSummary(name, pass.ms));
    const splitText = Object.entries(split)
        .map(([part, ms]) => `${part} ${fixed(ms)}`)
        .join(", ");
    return (
        `jsbeeb benchmark ${workload} (${model}): ${mhz.toFixed(2)} MHz. ` +
        `ms per emulated second, median of ${repeats} after ${warmupSeconds}s warm-up: ${summaries.join("; ")}. ` +
        `Split: ${splitText}. ` +
        `Display ${result.display} on ${result.renderer}. ` +
        `Commit ${result.commit} (${result.version}), crossOriginIsolated ${result.crossOriginIsolated}, ` +
        `${result.userAgent}`
    );
}

// The slots are told what the workload put in the drives first, as a restored state's are, so that the
// restore after it puts the workload's own fresh discs in behind them.
async function leaveAtStart(workload, processor, slots) {
    for (const slot of slots.driveSlots) {
        const ref = workload.snapshot.media?.[`disc${slot.index + 1}`];
        if (ref)
            slots.put(slot, processor.fdc.drives[slot.index].disc, ref, {
                inUrl: false,
                recent: false,
                entry: "restore",
            });
        else slots.eject(slot);
    }
    await restoreWorkload(processor, workload);
    slots.restored();
}

/**
 * The `?benchmark=<workload>` page: restores the workload and runs it unthrottled, driving `execute` itself in the
 * loop's tick-sized chunks, so the loop's timer, its animation frame and the rewind capture it triggers never run.
 * Each pass warms up for WarmupSeconds, then times Repeats emulated seconds:
 *
 * - `full`: a normal run's work, with the framebuffer copy (`onPaint`) and a present after every chunk, each timed
 *   on its own as it happens;
 * - `video`: the real video chip with its paints thrown away;
 * - `cpu`: the CPU and peripherals with FakeVideo in place of the video chip. It goes last, as the swap leaves the
 *   machine's call into the video chip seeing two classes.
 *
 * The record of the run is on `target.jsbeebBenchmark`: its `status` ("running", "done" or "failed"), then the
 * `result` and its `line`, or the `error`; its `done` resolves to the record when the run ends either way.
 */
export class BenchmarkPage {
    constructor(workload, { target = window, readWorkload: read = readWorkload } = {}) {
        this.readWorkload = read;
        let finish;
        this.record = { workload, status: "running", done: new Promise((resolve) => (finish = resolve)) };
        this.finish = finish;
        target.jsbeebBenchmark = this.record;
        this.dialog = document.getElementById(DialogId);
        this.dialog.querySelector(".benchmark-copy").addEventListener("click", () => this.copyLine());
    }

    /**
     * Runs the benchmark on the page's machine and shows what it found. The machine is left at the workload's
     * start and the loop asked to run it, so the page carries on as usual once the dialog is closed.
     */
    async run({ processor, display, audioHandler, slots, loop, modals, parsedQuery, takenFromHost, commit, version }) {
        const { workload: name } = this.record;
        this.showStatus(`Loading the ${name} workload...`);
        modals.show(DialogId);
        audioHandler.mute();
        try {
            const refused = MeasureChangingParams.filter((param) => Object.hasOwn(parsedQuery, param));
            if (refused.length)
                throw new Error(`${refused.join(", ")} would change what is measured; take it out of the URL`);
            const workload = await this.readWorkload(name);
            if (!isSameModel(workload.model, processor.model.name)) {
                throw new Error(
                    `The ${name} workload runs on the ${workload.model}: add &model=${workload.model} to the URL`,
                );
            }
            const misfit = misfitting(workload, takenFromHost);
            if (misfit) throw new Error(misfit);
            const measured = await this.measure(workload, {
                processor,
                display,
                audioHandler,
                clocksPerSecond: loop.clocksPerSecond,
            });
            await leaveAtStart(workload, processor, slots);
            const result = {
                ...measured,
                commit,
                version,
                display: display.filterClass.getDisplayConfig().name,
                renderer: display.canvas.renderer,
                crossOriginIsolated: !!window.crossOriginIsolated,
                userAgent: navigator.userAgent,
            };
            const line = resultLine(result);
            console.log(line);
            Object.assign(this.record, { status: "done", result, line });
            this.showStatus("Done. The line below has every figure; the machine runs the workload once this closes.");
            this.showLine(line);
            this.allowClose();
            this.finish(this.record);
            loop.go();
        } catch (error) {
            this.fail(error);
        }
    }

    /** Ends a run still going as failed, leaving the machine stopped wherever the failure left it. */
    fail(error) {
        if (this.record.status !== "running") return;
        console.warn("Benchmark failed:", error);
        Object.assign(this.record, { status: "failed", error: error.message });
        this.showStatus(`The benchmark stopped: ${error.message}. Reload the page without it to use the emulator.`);
        this.allowClose();
        this.finish(this.record);
    }

    async measure(workload, { processor, display, audioHandler, clocksPerSecond }) {
        const tickCycles = (clocksPerSecond * TickMs) / 1000;
        const video = processor.video;

        const runSecond = (presents) => {
            display.takePaintMs();
            let presentMs = 0;
            const start = performance.now();
            for (let chunk = 0; chunk < ChunksPerSecond; ++chunk) {
                if (!processor.execute(tickCycles)) throw new Error(`The CPU stopped at &${processor.pc.toString(16)}`);
                audioHandler.flushChipEvents();
                if (presents) {
                    const presentStart = performance.now();
                    display.present();
                    presentMs += performance.now() - presentStart;
                }
            }
            return { ms: performance.now() - start, copyMs: display.takePaintMs(), presentMs };
        };

        const runPass = async (pass, setUp) => {
            await restoreWorkload(processor, workload);
            const tearDown = setUp();
            try {
                for (let second = 0; second < WarmupSeconds; ++second) {
                    this.showStatus(`${pass}: warming up, ${second + 1} of ${WarmupSeconds}`);
                    runSecond(pass === "full");
                    await yieldToPage();
                }
                const samples = [];
                for (let repeat = 0; repeat < Repeats; ++repeat) {
                    this.showStatus(`${pass}: measuring, ${repeat + 1} of ${Repeats}`);
                    samples.push(runSecond(pass === "full"));
                    await yieldToPage();
                }
                checkWorkload(processor, workload);
                return samples;
            } finally {
                tearDown();
            }
        };

        const full = await runPass("full", () => () => {});
        const videoOnly = await runPass("video", () => {
            const paint = video.paint_ext;
            video.paint_ext = noPaint;
            return () => (video.paint_ext = paint);
        });
        const cpu = await runPass("cpu", () => {
            const fake = new FakeVideo();
            fake.reset(processor, processor.sysvia);
            Object.assign(processor, { video: fake, crtc: fake.crtc, ula: fake.ula });
            return () => Object.assign(processor, { video, crtc: video.crtc, ula: video.ula });
        });

        const msOf = (samples, field = "ms") => summarise(samples.map((sample) => sample[field]));
        const passes = { full: { ms: msOf(full) }, video: { ms: msOf(videoOnly) }, cpu: { ms: msOf(cpu) } };
        return {
            workload: workload.name,
            model: workload.model,
            repeats: Repeats,
            warmupSeconds: WarmupSeconds,
            tickCycles,
            mhz: clocksPerSecond / passes.full.ms.median / 1000,
            passes,
            split: {
                cpu: passes.cpu.ms.median,
                video: passes.video.ms.median - passes.cpu.ms.median,
                copy: msOf(full, "copyMs").median,
                present: msOf(full, "presentMs").median,
            },
            samples: { full, video: videoOnly, cpu },
        };
    }

    // Until now the dialog has no way out: closing it would let the loop be started under the run.
    allowClose() {
        for (const button of this.dialog.querySelectorAll(".benchmark-close")) button.hidden = false;
    }

    showStatus(text) {
        this.dialog.querySelector(".benchmark-status").textContent = text;
    }

    showLine(line) {
        const lineElement = this.dialog.querySelector(".benchmark-line");
        lineElement.value = line;
        lineElement.hidden = false;
        this.dialog.querySelector(".benchmark-copy").hidden = false;
    }

    // Not every browser lets a page write the clipboard; the selected text can be copied by hand.
    async copyLine() {
        const lineElement = this.dialog.querySelector(".benchmark-line");
        lineElement.select();
        try {
            await navigator.clipboard.writeText(lineElement.value);
        } catch (error) {
            console.log(`Unable to copy the benchmark line: ${error}`);
        }
    }
}
