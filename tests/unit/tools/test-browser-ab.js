import { describe, expect, it } from "vitest";

import { checkSamePage, isOffsite, parseOptions, throughput } from "../../../tools/browser-ab.js";

const Projects = [
    { name: "chrome", use: { channel: "chrome" } },
    { name: "firefox", use: { browserName: "firefox" } },
];

describe("parseOptions", () => {
    it("reads the sides, the workloads and the defaults", () => {
        expect(parseOptions(["main", "HEAD", "elite"], Projects)).toMatchObject({
            specs: ["main", "HEAD"],
            workloads: ["elite"],
            project: "chrome",
            browserName: "chromium",
            channel: "chrome",
            gl: "software",
            fresh: "context",
            pass: "full",
            statistic: "median",
            minPairs: 8,
            maxPairs: 30,
            horizon: 0.02,
            profileSides: [],
        });
    });

    it("takes the browser from the named project", () => {
        expect(parseOptions(["a", "b", "--project", "firefox"], Projects)).toMatchObject({
            browserName: "firefox",
            channel: undefined,
        });
    });

    it.each([
        [["main"], "Name two sides"],
        [["a", "b", "--project", "safari"], '--project is one of chrome, firefox, not "safari"'],
        [["a", "b", "--gl", "gpu"], '--gl must be one of software, hardware, not "gpu"'],
        [["a", "b", "--fresh", "page"], '--fresh is one of context, browser, not "page"'],
        [["a", "b", "--pass", "copy"], '--pass is one of full, video, cpu, not "copy"'],
        [["a", "b", "--statistic", "mean"], '--statistic is one of median, total, not "mean"'],
        [["a", "b", "--cpu-prof", "c"], '--cpu-prof takes a, b or both, not "c"'],
        [["a", "b", "--project", "firefox", "--cpu-prof", "a"], "--cpu-prof needs Chrome's profiler, not firefox"],
    ])("refuses %j before anything runs", (args, message) => {
        expect(() => parseOptions(args, Projects)).toThrow(message);
    });
});

describe("throughput", () => {
    const secondsMs = [200, 400, 400];
    const result = {
        mhz: 2 / 0.4,
        passes: { full: { ms: { median: 400 } }, cpu: { ms: { median: 100 } } },
        samples: { full: secondsMs.map((ms) => ({ ms })), cpu: [{ ms: 100 }] },
    };

    it("is the pass's median emulated second in virtual MHz", () => {
        expect(throughput(result, "full", "median")).toBeCloseTo(5, 10);
        expect(throughput(result, "cpu", "median")).toBeCloseTo(20, 10);
    });

    it("counts every second's time with the total statistic", () => {
        expect(throughput(result, "full", "total")).toBeCloseTo(2e6 / (1000 / 3) / 1000, 10);
    });
});

describe("checkSamePage", () => {
    const page = { renderer: "webgl", display: "pal", crossOriginIsolated: false, userAgent: "Chrome/151" };

    it("lets two sides that ran alike carry on, whatever their commits", () => {
        const seen = {};
        checkSamePage(seen, "a", { ...page, commit: "abc" });
        expect(() => checkSamePage(seen, "b", { ...page, commit: "def" })).not.toThrow();
    });

    it.each([
        ["renderer", "canvas"],
        ["display", "rgb"],
        ["crossOriginIsolated", true],
        ["userAgent", "Chrome/152"],
    ])("stops the run when the sides' pages differ in %s", (field, value) => {
        const seen = {};
        checkSamePage(seen, "a", page);
        expect(() => checkSamePage(seen, "b", { ...page, [field]: value })).toThrow(
            "A page of B ran differently from the first",
        );
    });

    it("stops the run when a later page of the same side differs", () => {
        const seen = {};
        checkSamePage(seen, "a", page);
        checkSamePage(seen, "b", page);
        expect(() => checkSamePage(seen, "b", { ...page, renderer: "canvas" })).toThrow("A page of B");
    });
});

describe("isOffsite", () => {
    it.each([
        ["http://127.0.0.1:4000/index.html", false],
        ["http://localhost:4000/", false],
        ["http://[::1]:4000/", false],
        ["data:text/plain,x", false],
        ["https://fonts.googleapis.com/css2", true],
        ["https://bbc.xania.org/", true],
    ])("%s is offsite: %s", (url, offsite) => {
        expect(isOffsite(new URL(url))).toBe(offsite);
    });
});
