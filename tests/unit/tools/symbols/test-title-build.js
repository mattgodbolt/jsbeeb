import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { environmentWithoutGit } from "../../../../tools/symbols/baron-build.js";
import { assemblerOf, withTitleSource } from "../../../../tools/symbols/title-build.js";

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

const StubBeebasm = `#!/bin/sh
if [ "$1" = "--help" ]; then echo "beebasm 1.11"; exit 0; fi
echo "[{}]" > "$6"
printf X > PROG
echo "Saving file 'PROG'"
`;

const config = (assembler) => ({ id: "demo", source: { assembler, assemble: "main.asm" } });

describe("assemblerOf", () => {
    it("is baron unless the config names beebasm", () => {
        expect(assemblerOf(config(undefined))).toBe("baron");
        expect(assemblerOf(config("baron"))).toBe("baron");
        expect(assemblerOf(config("beebasm"))).toBe("beebasm");
    });

    it("refuses an assembler no importer reads", () => {
        expect(() => assemblerOf(config("BeebAsm"))).toThrow("demo's source.assembler is BeebAsm");
    });
});

describe("withTitleSource", () => {
    let dir;
    const git = (...args) =>
        execFileSync("git", ["-C", path.join(dir, "repo"), ...IsolatedGitConfig, ...args], {
            encoding: "utf8",
            env: environmentWithoutGit(),
        }).trim();

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "symbols-title-"));
        mkdirSync(path.join(dir, "repo"));
        git("init", "-q");
        writeFileSync(path.join(dir, "repo", "main.asm"), "RTS\n");
        git("add", ".");
        git("commit", "-q", "-m", "source");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("builds a beebasm title with beebasm, and has no files directory for it", async () => {
        const beebasm = path.join(dir, "beebasm");
        writeFileSync(beebasm, StubBeebasm);
        chmodSync(beebasm, 0o755);
        const pinned = {
            id: "demo",
            source: {
                repository: pathToFileURL(path.join(dir, "repo")).href,
                commit: git("rev-parse", "HEAD"),
                assembler: "beebasm",
                assemble: "main.asm",
            },
        };
        const made = await withTitleSource(pinned, { beebasm }, (found) => found);
        expect(made.filesDir).toBeNull();
        expect(path.basename(made.sourceDir)).toBe("source");
    });
});
