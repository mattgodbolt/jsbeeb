#!/usr/bin/env node
/**
 * Makes a title's symbol sets from its beebasm build (beebasm-build.js): the listing, the label dump,
 * the values of its `=` names and the files it SAVEs. A curator's config under symbols-src/ says which
 * saved files make a set and where each is cut into regions, in the source's own names;
 * docs/symbol-importers.md says how the names and anchors are chosen.
 *
 * Usage: node tools/symbols/import-beebasm.js --config symbols-src/nevryon.json
 *            [--source <checkout>] [--beebasm <path>] [--out public/symbols/sets] [--verbose]
 *
 * Fetches the config's commit of its repository, or takes `--source`, a clean checkout of it, and
 * assembles it with `--beebasm`, else $BEEBASM, else `beebasm` on the PATH. Writes <config id>-<set id>.json
 * for each set, then `node tools/symbols/build-index.js` remakes the index. Refuses to write anything
 * if a region can't be anchored, its anchors match another of the build's images, or a set fails the
 * index's checks.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseSet } from "../../src/symbol-sets.js";
import { chooseAnchors, storesIn } from "./anchor-chooser.js";
import { BuildOptions, BuildUsage, PrintPrefix, withBeebasmBuild } from "./beebasm-build.js";
import { labelName, parseBeebasmListing, parseLabelDump } from "./beebasm-listing.js";
import { readMosSets, SymbolsDir } from "./build-index.js";
import { placedFiles } from "./corpus-check.js";
import { evaluate, setJson, writeTitle } from "./import-baron.js";

const AddressLimit = 0x10000;
const OpcodeLdxImmediate = 0xa2;
const OpcodeLdyImmediate = 0xa0;
const SetsDir = path.join(SymbolsDir, "sets");

const hex = (address) => `&${address.toString(16).toUpperCase().padStart(4, "0")}`;
const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

/** The last index in `sorted` whose key is at most `key`, or -1. */
function lastAtMost(sorted, key, keyOf) {
    let low = 0;
    let high = sorted.length - 1;
    let found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (keyOf(sorted[mid]) <= key) {
            found = mid;
            low = mid + 1;
        } else high = mid - 1;
    }
    return found;
}

/**
 * The statements in memory when a SAVE runs: of those listed before it, each that nothing listed later
 * has assembled over.
 */
function statementsInMemory(statements, before) {
    const owner = new Map();
    for (const statement of statements) {
        if (statement.order > before) break;
        for (let i = 0; i < Math.max(1, statement.bytes.length); i++) owner.set(statement.address + i, statement);
    }
    return [...new Set(owner.values())]
        .filter((statement) => owner.get(statement.address) === statement)
        .sort((a, b) => a.address - b.address);
}

const agrees = (statement, data, start) =>
    statement.bytes.every((byte, i) => {
        const offset = statement.address - start + i;
        return offset >= data.length || data[offset] === byte;
    });

/**
 * Where a saved file starts, which the listing doesn't say: the address, of a statement or label listed
 * before its SAVE, from which the file agrees with every statement it covers and covers the most.
 */
export function savedStart(name, data, inMemory, labelAddresses) {
    const starts = [...new Set([...inMemory.map((s) => s.address), ...labelAddresses])].sort((a, b) => a - b);
    let best = [];
    let bestCount = 0;
    for (const start of starts) {
        const first = lastAtMost(inMemory, start - 1, (s) => s.address) + 1;
        const last = lastAtMost(inMemory, start + data.length - 1, (s) => s.address);
        const covered = inMemory.slice(first, last + 1);
        if (!covered.length || !covered.every((statement) => agrees(statement, data, start))) continue;
        if (covered.length > bestCount) {
            best = [start];
            bestCount = covered.length;
        } else if (covered.length === bestCount) best.push(start);
    }
    if (best.length !== 1)
        throw new Error(
            best.length
                ? `${name} could start at any of ${best.map(hex).join(", ")}`
                : `${name} agrees with no statement listed before it's saved`,
        );
    return best[0];
}

/**
 * A beebasm build as the importer reads it: each saved file where it runs, with its statements and
 * labels, every label, and the `=` names that hold numbers.
 * @param {ReturnType<typeof import("./beebasm-build.js").assemble>} build
 */
export function beebasmBuild({ listing, dump, saved, names, operandNames }) {
    const parsed = parseBeebasmListing(listing, PrintPrefix);
    const dumped = parseLabelDump(dump);
    if (dumped.length !== parsed.labels.length)
        throw new Error(`The listing shows ${parsed.labels.length} labels and the dump ${dumped.length}`);
    const labels = parsed.labels.map(({ order, name }, i) => {
        const { identifier, address } = dumped[i];
        const qualified = labelName(identifier);
        if (qualified.name.split(".").at(-1) !== name)
            throw new Error(`The listing's label ${i}, ${name}, is ${identifier} in the dump`);
        return { order, address, ...qualified };
    });
    const constants = new Map();
    for (const name of names) {
        const value = Number(parsed.printed.get(name));
        if (Number.isInteger(value)) constants.set(name, value);
    }
    const { statements } = parsed;
    const files = new Map(
        parsed.saves.map(({ order, file }) => {
            const data = saved.get(file);
            const inMemory = statementsInMemory(statements, order);
            const listedBefore = labels.filter((label) => label.order < order);
            const start = savedStart(
                file,
                data,
                inMemory,
                listedBefore.map(({ address }) => address),
            );
            return [file, savedFile(file, data, start, inMemory, listedBefore, statements)];
        }),
    );
    return { files, labels, constants, operandNames };
}

/** One saved file: where it runs, its bytes, and its statements and labels. */
function savedFile(name, data, start, inMemory, labels, allStatements) {
    const end = start + data.length;
    const file = { name, start, end, data, statements: [], labels: [] };
    const listed = inMemory.filter((s) => s.address >= start && s.address < end);
    const held = new Set(listed);
    for (const label of labels) {
        const before = lastAtMost(allStatements, label.order, (s) => s.order);
        const next = allStatements[before + 1];
        const previous = allStatements[before];
        const inFile =
            (next && next.address === label.address && held.has(next)) ||
            (previous && held.has(previous) && label.address >= start && label.address < end);
        if (inFile) file.labels.push(label);
    }
    const boundaries = [...new Set([...listed.map((s) => s.address), ...file.labels.map((l) => l.address), end])].sort(
        (a, b) => a - b,
    );
    file.statements = listed.map((statement) => {
        const fullyListed = !statement.truncated && !statement.skip;
        const until = fullyListed
            ? Math.min(statement.address + statement.bytes.length, end)
            : boundaries[lastAtMost(boundaries, statement.address, (a) => a) + 1];
        return {
            address: statement.address,
            data: [...data.subarray(statement.address - start, until - start)],
            code: statement.code,
            skip: statement.skip,
            section: file,
            mnemonic: statement.mnemonic,
            target: statement.target,
        };
    });
    return file;
}

/**
 * Blocks a file hands the OS, found as an `LDX #lo` next to an `LDY #hi` (in either order) that make
 * a label's address, as `LDX #LO(block): LDY #HI(block)` assembles.
 */
export function osBlockTargets(file, labelAddresses) {
    const out = new Set();
    const code = file.statements.filter((s) => s.code);
    code.forEach((statement, i) => {
        const following = code[i + 1];
        if (!following || following.address !== statement.address + statement.data.length) return;
        const pair = [statement, following];
        const low = pair.find((s) => s.data[0] === OpcodeLdxImmediate);
        const high = pair.find((s) => s.data[0] === OpcodeLdyImmediate);
        if (!low || !high) return;
        const address = low.data[1] | (high.data[1] << 8);
        if (labelAddresses.has(address)) out.add(address);
    });
    return out;
}

/** Every address a system set (the MOS's) names, which a title's `=` names are left to. */
export function systemAddresses(dir = SymbolsDir) {
    const out = new Set();
    for (const file of readMosSets(dir)) {
        const set = parseSet(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
        for (const address of set.globals.keys()) out.add(address);
        for (const region of set.regions) for (const address of region.symbols.keys()) out.add(address);
    }
    return out;
}

const byRankDescending = (a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1];

class Importer {
    /**
     * @param {{name: string, data: Uint8Array}[]} discFiles - the original disc's files, placed where they load
     * @param {Set<number>} system - addresses a system set names
     */
    constructor(config, build, discFiles, system) {
        this.config = config;
        this.build = build;
        this.system = system;
        this.errors = [];
        this.notes = [];
        this.reasons = [];
        this.labelAddresses = new Set(build.labels.map(({ address }) => address));
        const programFiles = new Set(config.sets.flatMap((spec) => spec.regions.map((r) => r.file)));
        this.images = [
            ...[...build.files.values()].map((file) => ({
                name: `file ${file.name}`,
                memory: new Map([...file.data].map((byte, i) => [file.start + i, byte])),
                program: programFiles.has(file.name),
            })),
            ...discFiles.map(({ name, load, data }) => ({
                name: `disc ${name}`,
                memory: new Map([...data].map((byte, i) => [load + i, byte])),
                program: false,
            })),
        ];
    }

    lookup(name) {
        const label = this.build.labels.find((l) => !l.internal && l.name === name);
        return label?.address ?? this.build.constants.get(name);
    }

    file(name) {
        const file = this.build.files.get(name);
        if (!file) throw new Error(`Nothing is saved as ${name}`);
        return file;
    }

    region(spec, regionSpec) {
        const file = this.file(regionSpec.file);
        const find = (name) => this.lookup(name);
        const start = regionSpec.from === undefined ? file.start : evaluate(regionSpec.from, find);
        const end = regionSpec.to === undefined ? file.end : evaluate(regionSpec.to, find);
        if (start < file.start || end > file.end || start >= end)
            throw new Error(`${spec.id}/${regionSpec.name}: ${hex(start)}-${hex(end)} isn't inside ${file.name}`);
        return {
            name: regionSpec.name,
            fullName: `${spec.id}/${regionSpec.name}`,
            imageName: `file ${file.name}`,
            file,
            section: file,
            sectionInfo: {
                org: file.start,
                end: file.end,
                exec: null,
                statements: file.statements,
                labels: file.labels,
            },
            start,
            end,
            overwritten: regionSpec.overwritten === true,
            avoid: (regionSpec.avoid ?? []).map(([from, to]) => [evaluate(from, find), evaluate(to, find)]),
            osBlocks: osBlockTargets(file, this.labelAddresses),
            memory: new Map(range(start, end).map((address) => [address, file.data[address - file.start]])),
            symbols: new Map(),
            anchors: [],
        };
    }

    /** One set: its regions with their names and anchors, its globals, and the names left out. */
    set(spec) {
        const regions = spec.regions.map((regionSpec) => this.region(spec, regionSpec));
        const files = [...new Set(regions.map((region) => region.file))];
        const named = new Map(regions.map((region) => [region, new Map()]));
        const globalsNamed = new Map();
        const dropped = [];
        const add = (names, address, entry) => {
            if (!names.has(address)) names.set(address, []);
            names.get(address).push(entry);
        };
        const holds = (region, address) => address >= region.start && address < region.end;

        // Labels go to the region of the file they were assembled in.
        for (const file of files) {
            for (const label of file.labels) {
                if (label.internal) {
                    dropped.push([label.name, label.address, "in a scope beebasm names itself"]);
                    continue;
                }
                const homes = regions.filter((region) => region.file === file && holds(region, label.address));
                if (homes.length !== 1) {
                    dropped.push([label.name, label.address, "in no region"]);
                    continue;
                }
                add(named.get(homes[0]), label.address, { name: label.name, rank: [-label.scope.length, label.order] });
            }
        }

        // A `=` name counts as an address when the source writes it as a memory operand, an instruction
        // of the set names its value as one, and no other such name has that value.
        const code = files.flatMap((file) => file.statements.filter((s) => s.code && s.target !== null));
        const byValue = new Map();
        for (const [name, value] of this.build.constants) {
            if (value < 0 || value >= AddressLimit || !this.build.operandNames.has(name)) continue;
            if (!byValue.has(value)) byValue.set(value, []);
            byValue.get(value).push(name);
        }
        const order = new Map([...this.build.constants.keys()].map((name, i) => [name, i]));
        const labelled = new Set(regions.flatMap((region) => [...named.get(region).keys()]));
        for (const [value, names] of byValue) {
            const uses = code.filter((statement) => statement.target === value);
            if (!uses.length) continue;
            const why = this.system.has(value)
                ? "left to the MOS set"
                : labelled.has(value)
                  ? "a label names its address"
                  : names.length > 1
                    ? `${names.join(", ")} have the same value`
                    : null;
            if (why) {
                for (const name of names) dropped.push([name, value, why]);
                continue;
            }
            const [name] = names;
            const inside = regions.filter((region) => holds(region, value));
            const runs = (region, statement) => statement.section === region.file && holds(region, statement.address);
            if (inside.length === 1 && uses.every((statement) => runs(inside[0], statement)))
                add(named.get(inside[0]), value, { name, rank: [1, order.get(name)] });
            else add(globalsNamed, value, { name, rank: [uses.length, order.get(name)] });
        }

        const repeated = new Set();
        const choose = (names, chosen, saying) => {
            for (const [address, entries] of names) {
                entries.sort(byRankDescending);
                if (chosen.has(entries[0].name)) repeated.add(entries[0].name);
                chosen.set(entries[0].name, address);
                for (const { name } of entries.slice(1)) dropped.push([name, address, `${saying} ${entries[0].name}`]);
            }
        };
        for (const region of regions) choose(named.get(region), region.symbols, `${region.name} calls it`);
        const globals = new Map();
        choose(globalsNamed, globals, "the globals call it");
        const every = [...regions.flatMap((region) => [...region.symbols.keys()]), ...globals.keys()];
        const twice = [...new Set([...repeated, ...every.filter((name, i) => every.indexOf(name) !== i)])].sort();
        if (twice.length) throw new Error(`${spec.id}: names given twice: ${twice.join(", ")}`);

        const { stores } = storesIn(
            files.flatMap((file) => file.statements),
            { tableSizes: new Map(), moves: new Set() },
        );
        const spread = { bytesPerAnchor: this.config.bytesPerAnchor, spreadAnchors: this.config.spreadAnchors };
        for (const region of regions) {
            const { anchors, errors, notes, reasons } = chooseAnchors(region, stores, this.images, spread);
            region.anchors = anchors;
            this.errors.push(...errors);
            this.notes.push(...notes);
            this.reasons.push(...reasons);
        }
        return { json: setJson(this.config, spec, regions, globals), regions, dropped };
    }
}

/**
 * A title's sets from its beebasm build, as its config describes them.
 * @param {ReturnType<typeof beebasmBuild>} build
 * @param {{discFiles?: {name: string, load: number, data: Uint8Array}[], system?: Set<number>}} context
 */
export function importBeebasm(config, build, { discFiles = [], system = systemAddresses() } = {}) {
    if (config.licence === undefined) throw new Error(`${config.id}: the config gives no licence, so it makes no sets`);
    const importer = new Importer(config, build, discFiles, system);
    const sets = config.sets.map((spec) => ({
        id: spec.id,
        file: `${config.id}-${spec.id}.json`,
        ...importer.set(spec),
    }));
    return { sets, errors: importer.errors, notes: importer.notes, reasons: importer.reasons };
}

/** The original disc's files where they load, for the anchors to tell apart. */
export function discFilesOf(config, sourceDir) {
    if (config.source.disc === undefined) return [];
    return placedFiles({ [config.source.disc]: readFileSync(path.join(sourceDir, config.source.disc)) });
}

/**
 * Runs `use` with a curator's config and its title's beebasm build, made from the commit the config names.
 * @param {{source?: string, beebasm?: string}} options - as withBeebasmBuild takes them
 */
export function withTitle(configPath, options, use) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return withBeebasmBuild(config, options, (made) =>
        use({ ...made, config, build: beebasmBuild(made.build), discFiles: discFilesOf(config, made.sourceDir) }),
    );
}

async function main() {
    const { values } = parseArgs({
        options: {
            config: { type: "string" },
            ...BuildOptions,
            out: { type: "string", default: SetsDir },
            verbose: { type: "boolean", short: "v", default: false },
        },
    });
    if (!values.config) throw new Error(`Usage: import-beebasm.js --config <file> ${BuildUsage}`);
    return withTitle(values.config, values, ({ config, build, discFiles, beebasm }) => {
        console.log(`Assembled ${config.source.assemble} with ${beebasm}`);
        return writeTitle(config, importBeebasm(config, build, { discFiles }), values);
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (code) => process.exit(code),
        (error) => {
            console.error(error.message);
            process.exit(1);
        },
    );
}
