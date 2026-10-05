import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fingerprint } from "../../../../tools/registry/fingerprint.js";
import {
    baronArguments,
    baronVersion,
    BuildLayout,
    checkDisc,
    checkSourceCommit,
    cloneSource,
    environmentWithoutGit,
    sourcesToAssemble,
} from "../../../../tools/symbols/baron-build.js";

// The throwaway repository must not sign its commits or run hooks from the user's own git config.
const IsolatedGitConfig = [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
];

const DiscBytes = 2560;
const DiscFill = 0xe5;

describe("a title's source", () => {
    let dir;
    const git = (...args) =>
        execFileSync("git", ["-C", dir, ...IsolatedGitConfig, ...args], {
            encoding: "utf8",
            env: environmentWithoutGit(),
        }).trim();
    const disc = Buffer.alloc(DiscBytes, DiscFill);
    disc.write("DEMO", 0);
    const discKey = fingerprint("demo.ssd", disc).discKey;

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "symbols-source-"));
        git("init", "-q");
        mkdirSync(path.join(dir, "src"));
        mkdirSync(path.join(dir, "original"));
        writeFileSync(path.join(dir, "src", "prog.6502"), "RTS\n");
        writeFileSync(path.join(dir, "src", "data.6502"), "EQUB 1\n");
        writeFileSync(path.join(dir, "src", "os.6502inc"), "OSWRCH = &FFEE\n");
        writeFileSync(path.join(dir, "original", "demo.ssd"), disc);
        git("add", ".");
        git("commit", "-q", "-m", "source");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const pinned = (commit, more = {}) => ({
        source: { repository: pathToFileURL(dir).href, commit, assemble: ["src/*.6502"], ...more },
        madeFrom: [discKey],
    });

    describe("checkSourceCommit", () => {
        it("passes a clean checkout at the config's commit", () => {
            expect(() => checkSourceCommit(pinned(git("rev-parse", "HEAD")), dir)).not.toThrow();
        });

        it("looks at the source's checkout even when run from another repository's git hook", () => {
            const head = git("rev-parse", "HEAD");
            vi.stubEnv("GIT_DIR", path.join(tmpdir(), "no-such-repository"));
            vi.stubEnv("GIT_INDEX_FILE", path.join(tmpdir(), "no-such-index"));
            try {
                expect(() => checkSourceCommit(pinned(head), dir)).not.toThrow();
            } finally {
                vi.unstubAllEnvs();
            }
        });

        it("refuses a checkout at another commit, or with changes or new files", () => {
            const head = git("rev-parse", "HEAD");
            expect(() => checkSourceCommit(pinned("0".repeat(40)), dir)).toThrow(`is at ${head}`);
            writeFileSync(path.join(dir, "new.6502inc"), "X = 1\n");
            expect(() => checkSourceCommit(pinned(head), dir)).toThrow("has changes");
        });

        it("refuses a directory inside the checkout but not its root", () => {
            expect(() => checkSourceCommit(pinned(git("rev-parse", "HEAD")), path.join(dir, "src"))).toThrow(
                "isn't the root of its checkout",
            );
        });

        it("refuses a directory outside any checkout", () => {
            const outside = mkdtempSync(path.join(tmpdir(), "symbols-loose-"));
            try {
                expect(() => checkSourceCommit(pinned("0".repeat(40)), outside)).toThrow("isn't in a git checkout");
            } finally {
                rmSync(outside, { recursive: true, force: true });
            }
        });
    });

    describe("cloneSource", () => {
        let into;
        beforeEach(() => {
            into = mkdtempSync(path.join(tmpdir(), "symbols-clone-"));
        });
        afterEach(() => rmSync(into, { recursive: true, force: true }));

        it("checks out the config's commit, clean", () => {
            const first = git("rev-parse", "HEAD");
            writeFileSync(path.join(dir, "src", "prog.6502"), "NOP\n");
            git("commit", "-q", "-am", "later");
            const config = pinned(first);
            cloneSource(config, path.join(into, "source"));
            expect(() => checkSourceCommit(config, path.join(into, "source"))).not.toThrow();
            expect(readFileSync(path.join(into, "source", "src", "prog.6502"), "utf8")).toBe("RTS\n");
        });

        it("says which commit it couldn't fetch", () => {
            expect(() => cloneSource(pinned("1".repeat(40)), path.join(into, "source"))).toThrow(
                `Couldn't fetch ${"1".repeat(40)}`,
            );
        });
    });

    describe("checkDisc", () => {
        it("passes a disc madeFrom lists, and a config naming none", () => {
            expect(() => checkDisc(pinned("", { disc: "original/demo.ssd" }), dir)).not.toThrow();
            expect(() => checkDisc(pinned(""), dir)).not.toThrow();
        });

        it("refuses a disc madeFrom doesn't list", () => {
            const config = { ...pinned("", { disc: "original/demo.ssd" }), madeFrom: ["0".repeat(32)] };
            expect(() => checkDisc(config, dir)).toThrow(`original/demo.ssd is image ${discKey}`);
        });
    });

    describe("sourcesToAssemble", () => {
        it("is every file the globs match, sorted, each once", () => {
            const config = pinned("", { assemble: ["src/*.6502", "src/prog.6502"] });
            expect(sourcesToAssemble(config, dir)).toEqual(["src/data.6502", "src/prog.6502"]);
        });

        it("refuses globs that match nothing, or two sources of one name", () => {
            expect(() => sourcesToAssemble(pinned("", { assemble: ["nowhere/*.6502"] }), dir)).toThrow("matches");
            writeFileSync(path.join(dir, "prog.6502"), "RTS\n");
            expect(() => sourcesToAssemble(pinned("", { assemble: ["*.6502", "src/*.6502"] }), dir)).toThrow(
                "called prog",
            );
        });
    });
});

describe("baronArguments", () => {
    it("lists the source with -vv into its listing, its dump and its saved files with .inf sidecars", () => {
        expect(baronArguments("src/prog.6502", "/build")).toEqual([
            "-p",
            path.join("/build", BuildLayout.files),
            "--inf",
            "--symbols",
            path.join("/build", BuildLayout.symbols, "prog.json"),
            "-vv",
            "-log0",
            path.join("/build", BuildLayout.listings, "prog.txt"),
            "src/prog.6502",
        ]);
    });
});

describe("baronVersion", () => {
    it("says how to name baron when it can't run it", () => {
        expect(() => baronVersion(path.join(tmpdir(), "no-such-baron"))).toThrow("give --baron, or set BARON");
    });
});
