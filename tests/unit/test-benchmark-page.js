// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { resultLine, summarise } from "../../src/web/benchmark-page.js";

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
                    "Commit abc1234 (2.8.0), crossOriginIsolated false, Agent/1.0",
            );
        });
    });
});
