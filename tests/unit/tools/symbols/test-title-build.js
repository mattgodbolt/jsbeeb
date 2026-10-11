import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { environmentWithoutGit } from "../../../../tools/symbols/baron-build.js";
import { assemblerOf, importerOf, withTitleSource } from "../../../../tools/symbols/title-build.js";

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

const StubBaron = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "baron 9.9.9"; exit 1; fi
while [ $# -gt 1 ]; do
    case "$1" in
        -p) files=$2; shift ;;
        --symbols) symbols=$2; shift ;;
        -log0) listing=$2; shift ;;
    esac
    shift
done
echo "listing" > "$listing"
echo "{}" > "$symbols"
printf X > "$files/main"
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

describe("importerOf", () => {
    it("is py8dis's for a config that names py8dis, else its assembler's", () => {
        expect(importerOf({ ...config(undefined), py8dis: { repository: "r", commit: "c" } })).toBe("py8dis");
        expect(importerOf(config(undefined))).toBe("baron");
        expect(importerOf(config("beebasm"))).toBe("beebasm");
    });
});

describe("withTitleSource", () => {
    let dir;
    const git = (...args) =>
        execFileSync("git", ["-C", path.join(dir, "repo"), ...IsolatedGitConfig, ...args], {
            encoding: "utf8",
            env: environmentWithoutGit(),
        }).trim();
    const stub = (name, text) => {
        const file = path.join(dir, name);
        writeFileSync(file, text);
        chmodSync(file, 0o755);
        return file;
    };
    const pinned = (assembler, assemble) => ({
        id: "demo",
        source: {
            repository: pathToFileURL(path.join(dir, "repo")).href,
            commit: git("rev-parse", "HEAD"),
            assembler,
            assemble,
        },
    });

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "symbols-title-"));
        mkdirSync(path.join(dir, "repo"));
        git("init", "-q");
        writeFileSync(path.join(dir, "repo", "main.asm"), "RTS\n");
        writeFileSync(path.join(dir, "repo", "main.6502"), "RTS\n");
        git("add", ".");
        git("commit", "-q", "-m", "source");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("builds a baron title with baron, and gives the directory of its built files", async () => {
        const baron = stub("baron", StubBaron);
        for (const assembler of [undefined, "baron"]) {
            const built = await withTitleSource(pinned(assembler, ["main.6502"]), { baron }, ({ filesDir }) =>
                readFileSync(path.join(filesDir, "main"), "latin1"),
            );
            expect(built).toBe("X");
        }
    });

    it("builds a beebasm title with beebasm, and has no files directory for it", async () => {
        const beebasm = stub("beebasm", StubBeebasm);
        const made = await withTitleSource(pinned("beebasm", "main.asm"), { beebasm }, (found) => found);
        expect(made.filesDir).toBeNull();
        expect(path.basename(made.sourceDir)).toBe("source");
    });
});
