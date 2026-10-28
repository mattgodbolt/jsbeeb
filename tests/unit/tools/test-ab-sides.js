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
    gitEnv,
    installedNodeModules,
} from "../../../tools/ab-sides.js";

let scratch;
beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "test-ab-sides-"));
});
afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function checkoutWith(name, workloads) {
    const benchmarks = path.join(scratch, name);
    mkdirSync(benchmarks, { recursive: true });
    const manifest = Object.keys(workloads).map((workload) => ({ name: workload, snapshot: `${workload}.json.gz` }));
    writeFileSync(path.join(benchmarks, "workloads.json"), JSON.stringify({ workloads: manifest }));
    for (const [workload, bytes] of Object.entries(workloads))
        writeFileSync(path.join(benchmarks, `${workload}.json.gz`), bytes);
    return { benchmarks };
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
            env: gitEnv,
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

describe("installedNodeModules", () => {
    it("passes over a nearer node_modules holding a different version of a locked package", () => {
        const packages = {
            "": { name: "jsbeeb" },
            "node_modules/pako": { version: "2.1.0" },
            "node_modules/fsevents": { version: "2.3.3", optional: true },
        };
        const checkout = path.join(scratch, "main", ".claude", "worktrees", "agent");
        mkdirSync(checkout, { recursive: true });
        writeFileSync(path.join(checkout, "package-lock.json"), JSON.stringify({ packages }));
        const stray = path.join(scratch, "main", ".claude", "worktrees", "node_modules");
        mkdirSync(stray);
        const stale = { ...packages, "node_modules/pako": { version: "2.0.4" } };
        writeFileSync(path.join(stray, ".package-lock.json"), JSON.stringify({ packages: stale }));
        const install = path.join(scratch, "main", "node_modules");
        mkdirSync(install);
        const { "node_modules/fsevents": _skipped, ...installed } = packages;
        writeFileSync(path.join(install, ".package-lock.json"), JSON.stringify({ packages: installed }));

        expect(installedNodeModules(checkout)).toBe(install);
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
