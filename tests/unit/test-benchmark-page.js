// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { misfitting, resultLine, summarise } from "../../src/web/benchmark-page.js";
import { FittingParams } from "../../src/web/parameters.js";

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

    it.each(workloads.map((workload) => [workload.name, workload]))(
        "%s says whether it has each fitting the settings offer",
        (_, { fittings }) => {
            expect(Object.keys(fittings).sort()).toEqual([...FittingParams].sort());
        },
    );
});
