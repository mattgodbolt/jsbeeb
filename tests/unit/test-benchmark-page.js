// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BenchmarkPage, misfitting, resultLine, summarise } from "../../src/web/benchmark-page.js";
import { FittingParams } from "../../src/web/parameters.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const { workloads } = JSON.parse(readFileSync("public/benchmarks/workloads.json"));

const summary = (median) => ({
    median,
    min: median - 2,
    q1: median - 1,
    q3: median + 1,
    first: median + 3,
    last: median,
});

describe("benchmark page", () => {
    describe("summarise", () => {
        it("takes the median and quartiles between the closest ranks, and the first and last as taken", () => {
            expect(summarise([40, 10, 30, 20, 50])).toEqual({
                median: 30,
                min: 10,
                q1: 20,
                q3: 40,
                first: 40,
                last: 50,
            });
            expect(summarise([4, 1, 3, 2])).toEqual({ median: 2.5, min: 1, q1: 1.75, q3: 3.25, first: 4, last: 2 });
        });

        it("summarises one value as itself", () => {
            expect(summarise([7])).toEqual({ median: 7, min: 7, q1: 7, q3: 7, first: 7, last: 7 });
        });
    });

    describe("resultLine", () => {
        const result = {
            workload: "elite",
            model: "B-DFS1.2",
            mhz: 15.384,
            repeats: 10,
            warmupSeconds: 5,
            passes: { full: { ms: summary(130) }, video: { ms: summary(120) }, cpu: { ms: summary(40) } },
            split: { cpu: 40, video: 80, copy: 4.25, present: 3 },
            display: "RGB Monitor",
            renderer: "webgl",
            commit: "abc1234",
            version: "2.8.0",
            crossOriginIsolated: false,
            userAgent: "Agent/1.0",
        };

        it("puts every figure on one line", () => {
            expect(resultLine(result)).toBe(
                "jsbeeb benchmark elite (B-DFS1.2): 15.38 MHz. ms per emulated second, median of 10 after 5s warm-up: " +
                    "full 130.0 [min 128.0, IQR 129.0-131.0, first 133.0, last 130.0]; " +
                    "video 120.0 [min 118.0, IQR 119.0-121.0, first 123.0, last 120.0]; " +
                    "cpu 40.0 [min 38.0, IQR 39.0-41.0, first 43.0, last 40.0]. " +
                    "Split: cpu 40.0, video 80.0, copy 4.3, present 3.0. " +
                    "Display RGB Monitor on webgl. " +
                    "Commit abc1234 (2.8.0), crossOriginIsolated false, Agent/1.0",
            );
        });
    });

    describe("misfitting", () => {
        const workload = { name: "elite", fittings: { hasMusic5000: false, hasVideoNula: false } };

        it("passes a machine fitted as the workload is", () => {
            expect(misfitting(workload, { hasMusic5000: false, hasVideoNula: false, cpuMultiplier: 2 })).toBeNull();
        });

        it("names each fitting the machine has otherwise, as the URL sets it", () => {
            expect(misfitting(workload, { hasMusic5000: false, hasVideoNula: true })).toBe(
                "The elite workload runs with hasVideoNula=false; set that in the URL",
            );
            expect(misfitting(workload, { hasMusic5000: true, hasVideoNula: true })).toBe(
                "The elite workload runs with hasMusic5000=false, hasVideoNula=false; set those in the URL",
            );
        });
    });

    describe("run", () => {
        const elite = workloads.find(({ name }) => name === "elite");

        beforeEach(() => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            domFromIndexHtml("benchmark");
        });

        afterEach(teardownDom);

        const refusal = async (name, { query = {}, fitted = {} } = {}) => {
            const target = {};
            const page = new BenchmarkPage(name, {
                target,
                readWorkload: async (wanted) => workloads.find((workload) => workload.name === wanted),
            });
            await page.run({
                processor: { model: { name: "B-DFS1.2" } },
                audioHandler: { mute: () => {} },
                modals: { show: () => {} },
                parsedQuery: { benchmark: name, ...query },
                takenFromHost: { ...elite.fittings, ...fitted },
            });
            const { status, error } = target.jsbeebBenchmark;
            return { status, error, shown: document.querySelector("#benchmark .benchmark-status").textContent };
        };

        it.each([
            [
                "a workload for another model",
                () => refusal("master-shadow"),
                "The master-shadow workload runs on the Master: add &model=Master to the URL",
            ],
            [
                "a parameter that changes what is measured",
                () => refusal("elite", { query: { frameSkip: "2" } }),
                "frameSkip would change what is measured; take it out of the URL",
            ],
            [
                "a machine fitted otherwise than the workload",
                () => refusal("elite", { fitted: { hasVideoNula: true } }),
                "The elite workload runs with hasVideoNula=false; set that in the URL",
            ],
        ])("refuses %s, saying why", async (_, run, error) => {
            const { status, error: reported, shown } = await run();
            expect({ status, error: reported }).toEqual({ status: "failed", error });
            expect(shown).toContain(error);
        });
    });

    it.each(workloads.map((workload) => [workload.name, workload]))(
        "%s says whether it has each fitting the settings offer",
        (_, { fittings }) => {
            expect(Object.keys(fittings).sort()).toEqual([...FittingParams].sort());
        },
    );
});
