import { describe, expect, it } from "vitest";

import { TickMs } from "../../../src/emulation-tick.js";
import { parseOptions } from "../../../tools/node-ab.js";

describe("parseOptions", () => {
    it("reads the sides, the workloads and the defaults", () => {
        expect(parseOptions(["main", "HEAD", "elite", "mode7-text"])).toMatchObject({
            specs: ["main", "HEAD"],
            workloads: ["elite", "mode7-text"],
            minPairs: 8,
            maxPairs: 30,
            horizon: 0.02,
            warmupSecs: 5,
            measureSecs: 10,
            statistic: "median",
            fakeVideo: false,
            engine: "node",
            diagnostics: [],
        });
    });

    it("plans the profiling and deopt runs per side", () => {
        const { diagnostics } = parseOptions(["main", "HEAD", "--cpu-prof", "both", "--trace-deopt", "b"]);
        expect(diagnostics.map(({ option, side }) => `${option} ${side}`)).toEqual([
            "cpu-prof a",
            "cpu-prof b",
            "trace-deopt b",
        ]);
    });

    it("takes seconds in whole ticks, allowing for binary fractions", () => {
        expect(parseOptions(["a", "b", "--measure-secs", "1.1"]).measureSecs).toBeCloseTo(1.1, 10);
    });

    it.each([
        [["main"], "Name two sides"],
        [["a", "b", "--cpu-prof", "bb"], '--cpu-prof takes a, b or both, not "bb"'],
        [["a", "b", "--trace-deopt", "A"], "--trace-deopt takes a, b or both"],
        [["a", "b", "--statistic", "constructor"], '--statistic is median or total, not "constructor"'],
        [["a", "b", "--max-pairs", "x"], "--max-pairs takes a whole number of at least 8"],
        [["a", "b", "--max-pairs", "7"], "--max-pairs takes a whole number of at least 8"],
        [["a", "b", "--min-pairs", "12", "--max-pairs", "10"], "--max-pairs takes a whole number of at least 12"],
        [["a", "b", "--min-pairs", "2.5"], "--min-pairs takes a whole number"],
        [["a", "b", "--horizon", "x"], "--horizon takes a percentage above 0"],
        [["a", "b", "--horizon", "0"], "--horizon takes a percentage above 0"],
        [["a", "b", "--measure-secs", "1.234"], `--measure-secs takes seconds in whole ${TickMs} ms ticks`],
        [["a", "b", "--measure-secs", "0"], `--measure-secs takes seconds in whole ${TickMs} ms ticks`],
        [["a", "b", "--warmup-secs=-1"], `--warmup-secs takes seconds in whole ${TickMs} ms ticks`],
        [["a", "b", "--engine", "d8"], '--engine is one of node, v8, spidermonkey, javascriptcore, not "d8"'],
        [["a", "b", "--shell", "/bin/js"], "--shell needs an --engine other than node"],
        [["a", "b", "--engine", "v8", "--cpu-prof", "a"], "--cpu-prof and --trace-deopt are Node's flags"],
    ])("refuses %j before anything runs", (args, message) => {
        expect(() => parseOptions(args)).toThrow(message);
    });
});
