/**
 * Gets a beebasm title's source at the commit its config names and assembles it the importer's way, so
 * the source repository needs no build rules for jsbeeb: one run of beebasm on the config's main source,
 * in a copy of the checkout, with `-v` for the listing, `-dd -labels` for the labels, and a wrapper that
 * INCLUDEs the source and then PRINTs each name it assigns with `=`, since beebasm dumps no `=` names.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkAssembler, checkDisc, checkSourceCommit, cloneSource } from "./baron-build.js";
import { Mnemonics } from "./baron-listing.js";

export const BuildOptions = { source: { type: "string" }, beebasm: { type: "string" } };
export const BuildUsage = "[--source <checkout>] [--beebasm <path>]";

/** What starts a line of the listing that the wrapper's PRINTs wrote. */
export const PrintPrefix = "@jsbeeb-symbol";
export const Beebasm = "beebasm";
const ListingBytesMost = 1 << 30;
const MinimumVersion = [1, 11];
const Wrapper = "jsbeeb-symbols.asm";
const LabelsFile = "labels.txt";
const GitDir = ".git";
const Including = /^Including file (.*)$/gm;
const SavingFile = /^Saving file '(.*)'$/gm;
const Assignment = /(?:^|:)[ \t]*([A-Za-z_]\w*)[ \t]*=/gm;
const QuotedOrCharacter = /"(?:[^"]|"")*"|'.'/g;
const Comment = /[;\\].*$/;
const Definition = /^[ \t]*(?:\.([A-Za-z_]\w*)|([A-Za-z_]\w*)[ \t]*=(?!=))/;
const VersionLine = /^beebasm (\d+)\.(\d+)/;
const UnwritableSave = /^Error: (.*): Could not open object file for writing\.$/m;
const MemoryOperandName = new RegExp(
    String.raw`(?:^|[\s:])(?:${[...Mnemonics].join("|")})[ \t]+\(?[ \t]*([A-Za-z_]\w*)`,
    "gim",
);

/**
 * The first line of beebasm's `--help`, which names its version; refuses one older than the importer
 * reads, or one that can't be run.
 */
export function beebasmVersion(beebasm) {
    const { stdout, error } = spawnSync(beebasm, ["--help"], { encoding: "utf8" });
    const version = stdout?.split("\n")[0].trim() ?? "";
    const match = VersionLine.exec(version);
    if (error || !match)
        throw new Error(`Can't run beebasm as ${beebasm}: give --beebasm, or set BEEBASM`, { cause: error });
    const [major, minor] = [parseInt(match[1]), parseInt(match[2])];
    if (major < MinimumVersion[0] || (major === MinimumVersion[0] && minor < MinimumVersion[1]))
        throw new Error(
            `${beebasm} is ${version}, and the importer needs beebasm ${MinimumVersion.join(".")} or later`,
        );
    return version;
}

/** Every name a source assigns with `=`, in any scope: those not assigned at the top level are weeded out later. */
export function assignedNames(text) {
    return [...text.matchAll(Assignment)].map(([, name]) => name);
}

/**
 * Each label (`.name`) and `=` name a source defines, with the line it's on, from 1: every statement of a
 * line, outside its strings and its comment.
 * @returns {[string, number][]}
 */
export function definitionLines(text) {
    return text.split(/\r\n|\r|\n/).flatMap((line, i) =>
        line
            .replace(QuotedOrCharacter, '""')
            .replace(Comment, "")
            .split(":")
            .flatMap((statement) => {
                const match = Definition.exec(statement);
                return match ? [[match[1] ?? match[2], i + 1]] : [];
            }),
    );
}

/** Every name a source writes first in an instruction's operand, other than after `#`. */
export function memoryOperandNames(text) {
    return [...text.matchAll(MemoryOperandName)].map(([, name]) => name);
}

/** A source that assembles `main` and then PRINTs each of `names` as `PREFIX:name:value`. */
export function wrapperSource(main, names) {
    const quoted = (text) => `"${text.replaceAll('"', '""')}"`;
    return [
        `INCLUDE ${quoted(main)}`,
        ...names.map((name) => `PRINT ${quoted(`${PrintPrefix}:${name}:`)}, ${name}`),
        "",
    ].join("\n");
}

/** The line of the wrapper that a run stopped at because the name it PRINTs isn't a top-level one. */
function undefinedAt(output, wrapper) {
    for (const line of output.split("\n")) {
        if (!line.startsWith(`${wrapper}:`)) continue;
        const match = /^:(\d+): error: Symbol not defined/.exec(line.slice(wrapper.length));
        if (match) return parseInt(match[1]);
    }
    return null;
}

/**
 * Runs beebasm on the wrapper in `runDir` until every name it PRINTs is one the source assigns at the top
 * level, dropping each that isn't.
 * @returns {{stdout: string, stderr: string, names: string[]}}
 */
function runWrapped(beebasm, runDir, buildDir, main, names) {
    const wrapper = path.join(buildDir, Wrapper);
    const labels = path.join(buildDir, LabelsFile);
    let kept = [...names];
    for (;;) {
        writeFileSync(wrapper, wrapperSource(main, kept));
        const { stdout, stderr, status, error } = spawnSync(beebasm, ["-i", wrapper, "-v", "-dd", "-labels", labels], {
            cwd: runDir,
            encoding: "latin1",
            maxBuffer: ListingBytesMost,
        });
        if (error) throw new Error(`Couldn't run ${beebasm}`, { cause: error });
        if (status === 0) return { stdout, stderr, names: kept };
        const output = `${stdout}\n${stderr}`;
        const unwritable = UnwritableSave.exec(output)?.[1];
        if (unwritable !== undefined) {
            const dir = path.dirname(path.resolve(runDir, unwritable));
            if (existsSync(dir)) throw new Error(`beebasm can't write ${unwritable}, though ${dir} is there`);
            mkdirSync(dir, { recursive: true });
            continue;
        }
        const line = undefinedAt(output, wrapper);
        // The wrapper's first line is its INCLUDE, so its PRINTs start at line 2.
        const name = line === null ? undefined : kept[line - 2];
        if (name === undefined) {
            const errors = output.split("\n").filter((text) => /error/i.test(text));
            throw new Error(`beebasm failed on ${main}: ${errors.join("\n") || output.trim()}`);
        }
        kept = kept.filter((other) => other !== name);
    }
}

/**
 * Assembles the config's main source (`source.assemble`) in `workDir`, a copy of the checkout, running
 * beebasm in `source.directory` (the root if it names none), as source INCLUDEs are found from there.
 * @returns {{listing: string, dump: string, saved: Map<string, Uint8Array>, names: string[],
 *     operandNames: Set<string>, definitions: Map<string, string[]>}} the listing, the label dump, each
 *     SAVEd file by the name its SAVE gave, the `=` names PRINTed, the names the sources write as an
 *     instruction's memory operand, and every place (`<file>#L<line>`, from the root) each name is defined
 */
export function assemble(config, workDir, buildDir, beebasm) {
    const runDir = path.join(workDir, config.source.directory ?? ".");
    const main = path.join(workDir, config.source.assemble);
    mkdirSync(buildDir, { recursive: true });
    const first = runWrapped(beebasm, runDir, buildDir, main, []);
    const sources = new Set([...first.stderr.matchAll(Including)].map(([, file]) => path.resolve(runDir, file)));
    const texts = [...sources].map((file) => readFileSync(file, "latin1"));
    const definitions = new Map();
    [...sources].forEach((file, i) => {
        const fromRoot = path.relative(workDir, file).split(path.sep);
        if (fromRoot[0] === "..") return;
        for (const [name, line] of definitionLines(texts[i])) {
            if (!definitions.has(name)) definitions.set(name, []);
            definitions.get(name).push(`${fromRoot.join("/")}#L${line}`);
        }
    });
    const names = [...new Set(texts.flatMap(assignedNames))];
    const { stdout, names: kept } = runWrapped(beebasm, runDir, buildDir, main, names);
    const saved = new Map();
    for (const [, file] of stdout.matchAll(SavingFile)) {
        if (saved.has(file)) throw new Error(`${config.source.assemble} saves ${file} twice`);
        saved.set(file, readFileSync(path.resolve(runDir, file)));
    }
    return {
        listing: stdout,
        dump: readFileSync(path.join(buildDir, LabelsFile), "latin1"),
        saved,
        names: kept,
        operandNames: new Set(texts.flatMap(memoryOperandNames)),
        definitions,
    };
}

/**
 * Runs `use` with the config's source and its beebasm build, in a temporary directory removed afterwards.
 * The build runs in a copy of the checkout, since a SAVE writes wherever its source says.
 * @param {{source?: string, beebasm?: string}} options - an existing checkout of the config's commit to
 *     assemble instead of fetching one, and the beebasm to run (else BEEBASM, else `beebasm` on the PATH)
 * @param {(build: {sourceDir: string, build: ReturnType<typeof assemble>, beebasm: string}) => any} use
 */
export async function withBeebasmBuild(config, { source, beebasm } = {}, use) {
    checkAssembler(config, Beebasm);
    const named = beebasm ?? process.env.BEEBASM ?? "beebasm";
    const beebasmPath = path.basename(named) === named ? named : path.resolve(named);
    const version = beebasmVersion(beebasmPath);
    const temp = mkdtempSync(path.join(tmpdir(), "symbols-beebasm-"));
    try {
        const sourceDir = source ?? path.join(temp, "source");
        if (source === undefined) cloneSource(config, sourceDir);
        checkSourceCommit(config, sourceDir);
        checkDisc(config, sourceDir);
        const workDir = path.join(temp, "work");
        cpSync(sourceDir, workDir, { recursive: true, filter: (from) => path.basename(from) !== GitDir });
        const build = assemble(config, workDir, path.join(temp, "build"), beebasmPath);
        return await use({ sourceDir, build, beebasm: version });
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
