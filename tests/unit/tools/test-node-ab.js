import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    assertWritableFile,
    checkoutSha,
    checkWorkloads,
    comparableLock,
    parseOptions,
} from "../../../tools/node-ab.js";

let scratch;
beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "test-node-ab-"));
});
afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function checkoutWith(name, workloads) {
    const root = path.join(scratch, name);
    const dir = path.join(root, "public", "benchmarks");
    mkdirSync(dir, { recursive: true });
    const manifest = Object.keys(workloads).map((workload) => ({ name: workload, snapshot: `${workload}.json.gz` }));
    writeFileSync(path.join(dir, "workloads.json"), JSON.stringify({ workloads: manifest }));
    for (const [workload, bytes] of Object.entries(workloads))
        writeFileSync(path.join(dir, `${workload}.json.gz`), bytes);
    return { root };
}

describe("checkWorkloads", () => {
    it("says nothing when both sides have the same snapshots", () => {
        const warn = vi.spyOn(console, "error").mockImplementation(() => {});
        checkWorkloads([checkoutWith("a", { elite: "same" }), checkoutWith("b", { elite: "same" })], ["elite"]);
        expect(warn).not.toHaveBeenCalled();
    });

    it("warns of a snapshot that differs between the sides", () => {
        const warn = vi.spyOn(console, "error").mockImplementation(() => {});
        checkWorkloads([checkoutWith("a", { elite: "old" }), checkoutWith("b", { elite: "new" })], ["elite"]);
        expect(warn).toHaveBeenCalledWith('Warning: workload "elite" has a different snapshot on each side');
    });

    it.each([
        ["A", { other: "x" }, { elite: "x" }],
        ["B", { elite: "x" }, { other: "x" }],
    ])("names the side %s that lacks a workload", (side, a, b) => {
        expect(() => checkWorkloads([checkoutWith("a", a), checkoutWith("b", b)], ["elite"])).toThrow(
            `${side} has no workload "elite"`,
        );
    });
});

describe("checkoutSha", () => {
    const git = (...args) =>
        execFileSync("git", ["-C", scratch, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
            encoding: "utf8",
            env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
        }).trim();

    beforeEach(() => {
        git("init", "-q");
        writeFileSync(path.join(scratch, "tracked.txt"), "one");
        git("add", "tracked.txt");
        git("commit", "-q", "-m", "one");
    });

    it("is HEAD's sha, ignoring untracked files such as the runner's own output", () => {
        writeFileSync(path.join(scratch, "result.json"), "{}");
        expect(checkoutSha(scratch)).toBe(git("rev-parse", "HEAD"));
    });

    it("is marked dirty by a change to a tracked file", () => {
        writeFileSync(path.join(scratch, "tracked.txt"), "two");
        expect(checkoutSha(scratch)).toBe(`${git("rev-parse", "HEAD")}-dirty`);
    });

    it("is null outside git", () => {
        rmSync(path.join(scratch, ".git"), { recursive: true });
        expect(checkoutSha(scratch)).toBeNull();
    });
});

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
        [["a", "b", "--measure-secs", "1.234"], "--measure-secs takes seconds in whole"],
        [["a", "b", "--measure-secs", "0"], "--measure-secs takes seconds in whole"],
        [["a", "b", "--warmup-secs=-1"], "--warmup-secs takes seconds in whole"],
    ])("refuses %j before anything runs", (args, message) => {
        expect(() => parseOptions(args)).toThrow(message);
    });
});

describe("comparableLock", () => {
    const lock = (version, dependency) =>
        JSON.stringify({
            name: "jsbeeb",
            version,
            lockfileVersion: 3,
            packages: { "": { name: "jsbeeb", version }, "node_modules/pako": { version: dependency } },
        });

    it("ignores a release's version bump", () => {
        expect(comparableLock(lock("2.9.0", "2.1.0"))).toBe(comparableLock(lock("2.8.0", "2.1.0")));
    });

    it("sees a changed dependency", () => {
        expect(comparableLock(lock("2.8.0", "2.1.1"))).not.toBe(comparableLock(lock("2.8.0", "2.1.0")));
    });
});

describe("assertWritableFile", () => {
    it("accepts a new or existing file in a directory that exists", () => {
        writeFileSync(path.join(scratch, "old.json"), "{}");
        expect(() => assertWritableFile(path.join(scratch, "new.json"))).not.toThrow();
        expect(() => assertWritableFile(path.join(scratch, "old.json"))).not.toThrow();
    });

    it.each([
        ["a directory", (dir) => `${dir}/`],
        ["a file in a missing directory", (dir) => path.join(dir, "missing", "result.json")],
        ["a file under a file", (dir) => path.join(dir, "old.json", "result.json")],
    ])("refuses %s", (_what, target) => {
        writeFileSync(path.join(scratch, "old.json"), "{}");
        expect(() => assertWritableFile(target(scratch))).toThrow("Cannot write");
    });
});
