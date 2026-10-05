#!/usr/bin/env node
/**
 * Makes a title's symbol sets from its baron build: the symbol dump (`--symbols`), each source's -vv
 * listing and the built files with their .inf sidecars. A curator's config under symbols-src/ says
 * which programs make a set and where each is cut into regions, in the source's own names;
 * docs/symbol-importers.md says how the names and anchors are chosen.
 *
 * Usage: node tools/symbols/import-baron.js --config symbols-src/pipeline.json --build <build dir>
 *            [--out public/symbols/sets] [--verbose]
 *
 * Writes <config id>-<set id>.json for each set, then `node tools/symbols/build-index.js` remakes
 * the index. Refuses to write anything if a region can't be anchored, its anchors match another of
 * the build's images, a set fails the index's checks, or the build isn't of the commit the config
 * names.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Format } from "../../src/symbol-sets.js";
import { chooseAnchors, storesIn } from "./anchor-chooser.js";
import { parseBaronListing, sectionNamed } from "./baron-listing.js";
import { checkSet, formatJson, readMosSets, SymbolsDir } from "./build-index.js";

const AddressLimit = 0x10000;
const IoAddressMask = 0xffff;
const ListingExtension = ".txt";
const InfExtension = ".inf";
const SetsDir = path.join(SymbolsDir, "sets");

const Name = String.raw`[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*`;
const OperandToken = new RegExp(
    String.raw`\s*(?:&[0-9A-Fa-f]+|%[01]+|\d+|'(?:[^']|'')'|"(?:[^"]|"")*"|(?<name>${Name})|.)`,
    "g",
);
const Registers = new Set(["A", "X", "Y"]);
const OsBlockOperand = new RegExp(String.raw`^#\s*LO\(\s*(${Name})\s*\)$`);
const ExpressionToken = new RegExp(String.raw`\s*(?:&([0-9A-Fa-f]+)|(\d+)|(${Name})|([-+*/()]))`, "y");

export const hexAddress = (address) => `0x${address.toString(16).padStart(4, "0")}`;
const hex = (address) => `&${address.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * The name an operand's address is built on, its first name; null for an immediate operand, one with
 * no name, or one built on a FUNCTION's result.
 */
export function operandBase(operand) {
    if (!operand || operand.startsWith("#")) return null;
    for (const match of operand.matchAll(OperandToken)) {
        const name = match.groups.name;
        if (!name) continue;
        const rest = operand.slice(match.index + match[0].length).trimStart();
        return Registers.has(name.toUpperCase()) || rest.startsWith("(") ? null : name;
    }
    return null;
}

/**
 * A config expression: names, &hex, decimal, + - * / and brackets, worked out as the prototype's
 * Python did, in floating point and truncated at the end.
 * @param {string | number} expression
 * @param {(name: string) => number | undefined} lookup
 */
export function evaluate(expression, lookup) {
    const text = String(expression);
    const tokens = [];
    ExpressionToken.lastIndex = 0;
    while (ExpressionToken.lastIndex < text.length) {
        const start = ExpressionToken.lastIndex;
        const match = ExpressionToken.exec(text);
        if (!match) {
            if (/^\s*$/.test(text.slice(start))) break;
            throw new Error(`Can't evaluate "${text}"`);
        }
        const [, hexDigits, decimal, name, operator] = match;
        if (operator) tokens.push(operator);
        else if (name) {
            const value = lookup(name);
            if (value === undefined) throw new Error(`There's no symbol ${name} in "${text}"`);
            tokens.push(value);
        } else tokens.push(parseInt(hexDigits ?? decimal, hexDigits ? 16 : 10));
    }
    let next = 0;
    const fail = () => {
        throw new Error(`Can't evaluate "${text}"`);
    };
    const primary = () => {
        const token = tokens[next++];
        if (typeof token === "number") return token;
        if (token === "-") return -primary();
        if (token === "+") return primary();
        if (token !== "(") fail();
        const value = sum();
        if (tokens[next++] !== ")") fail();
        return value;
    };
    const product = () => {
        let value = primary();
        while (tokens[next] === "*" || tokens[next] === "/")
            value = tokens[next++] === "*" ? value * primary() : value / primary();
        return value;
    };
    const sum = () => {
        let value = product();
        while (tokens[next] === "+" || tokens[next] === "-")
            value = tokens[next++] === "+" ? value + product() : value - product();
        return value;
    };
    const value = sum();
    if (next !== tokens.length) fail();
    return Math.trunc(value);
}

/** One source file's listing and its symbols as the dump gives them. */
class Source {
    constructor(name, listing, symbols) {
        this.name = name;
        this.listing = listing;
        this.symbols = symbols;
        this.labelNames = new Set(listing.labels.map(({ name: label }) => label));
        for (const label of listing.labels)
            if (symbols[label.name] !== label.address)
                throw new Error(
                    `${name}: the listing has ${label.name} at ${hex(label.address)}, the symbol dump ${symbols[label.name]}`,
                );
    }

    /** The qualified name `name` means when written inside `scope`. */
    resolve(scope, name) {
        for (let depth = scope.length; depth >= 0; depth--) {
            if (scope.slice(0, depth).includes(null)) continue;
            const candidate = [...scope.slice(0, depth), name].join(".");
            if (Object.hasOwn(this.symbols, candidate)) return candidate;
        }
        return null;
    }

    /** A name's value if it's a number; undefined for a string, a list, a boolean or no such name. */
    lookup(name) {
        const value = name === null ? undefined : this.symbols[name];
        return Number.isInteger(value) ? value : undefined;
    }

    /** Looks a name up as a config writes it: in the source's own terms, or inside the scope a set leaves off. */
    finder(strip) {
        return (name) => this.lookup(name) ?? (strip ? this.lookup(`${strip}.${name}`) : undefined);
    }
}

/** The dump's entry for a listing: the one whose file name, less its extension, is the listing's. */
function dumpEntry(dump, name) {
    const keys = Object.keys(dump).filter((key) => path.parse(key).name === name);
    if (keys.length !== 1) throw new Error(`The symbol dump has ${keys.length} sources called ${name}`);
    return dump[keys[0]];
}

/**
 * The environment without git's own variables: run from a git hook, GIT_DIR or GIT_INDEX_FILE would
 * point `git -C dir` at the repository the hook belongs to.
 */
export function environmentWithoutGit() {
    return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
}

const git = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe", env: environmentWithoutGit() }).trim();

/**
 * Refuses a build directory that isn't in a git checkout of the config's commit with nothing changed or
 * added, since every set's `source` will name that commit. It can't tell a build left over from another
 * commit; the source repository's own build keeps that true.
 */
export function checkBuildCommit(config, buildDir) {
    let head;
    let changes;
    try {
        head = git(buildDir, "rev-parse", "HEAD");
        changes = git(buildDir, "status", "--porcelain");
    } catch (error) {
        throw new Error(`${buildDir} isn't in a git checkout, so nothing says it's ${config.source.commit}`, {
            cause: error,
        });
    }
    if (head !== config.source.commit)
        throw new Error(`The checkout ${buildDir} is in is at ${head}, and the config names ${config.source.commit}`);
    if (changes) throw new Error(`The checkout ${buildDir} is in has changes, so it isn't ${config.source.commit}`);
}

/** A rank to sort candidates for one address by, highest first, keeping the first of equals. */
const byRankDescending = (a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1];

const byAddress = (names) =>
    Object.fromEntries(
        [...names]
            .sort(([nameA, a], [nameB, b]) => a - b || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0))
            .map(([name, address]) => [name, hexAddress(address)]),
    );

/**
 * A baron build as the importer reads it.
 * @param {Map<string, string>} listings - each source's -vv listing, by the source's name
 * @param {object} dump - the symbol dump, by source file
 * @param {{name: string, load: number, data: Uint8Array}[]} files - the built files, where each loads
 */
export function baronBuild(listings, dump, files) {
    const sources = new Map(
        [...listings].map(([name, text]) => [name, new Source(name, parseBaronListing(text), dumpEntry(dump, name))]),
    );
    return { sources, files };
}

/** Reads a baron build from disc: every listing, the dump, and every built file with an .inf. */
export function readBaronBuild(buildDir, buildLayout) {
    const listingsDir = path.join(buildDir, buildLayout.listings);
    const filesDir = path.join(buildDir, buildLayout.files);
    const dump = JSON.parse(readFileSync(path.join(buildDir, buildLayout.symbols), "utf8"));
    const listings = new Map(
        readdirSync(listingsDir)
            .filter((name) => name.endsWith(ListingExtension))
            .sort()
            .map((file) => [
                file.slice(0, -ListingExtension.length),
                readFileSync(path.join(listingsDir, file), "latin1"),
            ]),
    );
    const files = readdirSync(filesDir)
        .filter((name) => name.endsWith(InfExtension))
        .sort()
        .map((inf) => {
            const name = inf.slice(0, -InfExtension.length);
            const load =
                parseInt(readFileSync(path.join(filesDir, inf), "latin1").trim().split(/\s+/)[1], 16) & IoAddressMask;
            return { name, load, data: readFileSync(path.join(filesDir, name)) };
        });
    return baronBuild(listings, dump, files);
}

/**
 * Everything the build puts in memory, at the addresses it occupies: each section where it runs, and
 * each file where it loads.
 */
function buildImages({ sources, files }, programSources) {
    const images = [];
    for (const source of sources.values())
        for (const section of source.listing.sections) {
            const memory = section.image();
            if (memory.size)
                images.push({
                    name: `${source.name}:${section.name}`,
                    memory,
                    program: programSources.has(source.name),
                });
        }
    for (const { name, load, data } of files)
        images.push({
            name: `file ${name}`,
            memory: new Map([...data].map((byte, i) => [load + i, byte])),
            program: false,
        });
    return images;
}

/** Addresses of the blocks a source hands the OS with `LDX #LO(block)`. */
function osBlockTargets(source) {
    const out = new Set();
    for (const statement of source.listing.statements) {
        if (statement.mnemonic !== "LDX") continue;
        const name = OsBlockOperand.exec(statement.operand)?.[1];
        const resolved = name && source.resolve(statement.scope, name);
        if (resolved && source.labelNames.has(resolved)) out.add(source.lookup(resolved));
    }
    return out;
}

class Importer {
    constructor(config, build) {
        this.config = config;
        this.build = build;
        this.errors = [];
        this.notes = [];
        this.reasons = [];
        this.systemNames = new Set();
        for (const include of config.leftToSystemSets ?? []) {
            const names = [...build.sources.values()].flatMap((source) => [
                ...(source.listing.includedNames.get(include) ?? []),
            ]);
            if (!names.length) throw new Error(`No listing INCLUDEs ${include}, which leftToSystemSets names`);
            names.forEach((name) => this.systemNames.add(name));
        }
        const programSources = new Set(
            config.sets.flatMap((spec) => [...spec.sources, ...spec.regions.map((r) => r.source).filter(Boolean)]),
        );
        this.images = buildImages(build, programSources);
        this.osBlocks = new Map();
    }

    source(name) {
        const source = this.build.sources.get(name);
        if (!source) throw new Error(`There's no listing for ${name}`);
        return source;
    }

    osBlocksOf(source) {
        if (!this.osBlocks.has(source)) this.osBlocks.set(source, osBlockTargets(source));
        return this.osBlocks.get(source);
    }

    region(spec, regionSpec) {
        const source = this.source(regionSpec.source ?? spec.sources[0]);
        const section = sectionNamed(source.listing, regionSpec.section);
        const find = source.finder(spec.stripScope);
        const start = regionSpec.from === undefined ? section.org : evaluate(regionSpec.from, find);
        const end = regionSpec.to === undefined ? section.end : evaluate(regionSpec.to, find);
        const memory = new Map([...section.image()].filter(([address]) => address >= start && address < end));
        return {
            name: regionSpec.name,
            fullName: `${spec.id}/${regionSpec.name}`,
            imageName: `${source.name}:${section.name}`,
            source,
            section,
            sectionInfo: {
                org: section.org,
                end: section.end,
                exec: section.exec,
                statements: section.statements,
                labels: source.listing.labels.filter((label) => label.section === section),
            },
            start,
            end,
            overwritten: regionSpec.overwritten === true,
            avoid: (regionSpec.avoid ?? []).map(([from, to]) => [evaluate(from, find), evaluate(to, find)]),
            osBlocks: this.osBlocksOf(source),
            memory,
            symbols: new Map(),
            anchors: [],
        };
    }

    /** The program's stores, with each instruction's operand base looked up for the table sizes. */
    stores(spec, source) {
        const find = source.finder(spec.stripScope);
        const lookupOrFail = (name) => {
            const value = find(name);
            if (value === undefined) throw new Error(`${spec.id}: a table or a move names no symbol: ${name}`);
            return value;
        };
        const tableSizes = new Map(
            Object.entries(spec.tableSizes ?? {}).map(([name, size]) => [lookupOrFail(name), evaluate(size, find)]),
        );
        const moves = new Set((spec.moves ?? []).map(lookupOrFail));
        for (const statement of source.listing.statements) {
            const base = statement.code ? operandBase(statement.operand) : null;
            statement.base = base ? source.lookup(source.resolve(statement.scope, base)) : undefined;
        }
        try {
            return storesIn(source.listing.statements, { tableSizes, moves });
        } catch (error) {
            throw new Error(`${spec.id}: ${error.message}`, { cause: error });
        }
    }

    /** One set: its regions with their names and anchors, its globals, and the names left out. */
    set(spec) {
        const sources = spec.sources.map((name) => this.source(name));
        const strip = spec.stripScope;
        const shown = (name) => (strip && name.startsWith(`${strip}.`) ? name.slice(strip.length + 1) : name);
        const globalsSections = new Set(spec.globalsSections ?? []);
        const regions = spec.regions.map((regionSpec) => this.region(spec, regionSpec));
        const named = new Map(regions.map((region) => [region, new Map()]));
        const globalsNamed = new Map();
        const dropped = [];
        const add = (names, address, entry) => {
            if (!names.has(address)) names.set(address, []);
            names.get(address).push(entry);
        };
        const holds = (region, address) => address >= region.start && address < region.end;
        const runs = (region, statement) => statement.section === region.section && holds(region, statement.address);

        // Labels belong to the region of the section they're assembled in.
        const labelSources = [...new Set([...sources, ...regions.map((region) => region.source)])];
        for (const source of labelSources) {
            for (const label of source.listing.labels) {
                if (label.name === strip) continue;
                const section = label.section;
                if (section && globalsSections.has(section.name)) {
                    if (label.address >= section.org && label.address < section.end)
                        add(globalsNamed, label.address, { name: shown(label.name), rank: [0, label.order] });
                    else dropped.push([shown(label.name), label.address, "past its section's end"]);
                    continue;
                }
                const homes = regions.filter(
                    (region) => region.source === source && region.section === section && holds(region, label.address),
                );
                if (homes.length !== 1) {
                    dropped.push([shown(label.name), label.address, "in no region"]);
                    continue;
                }
                add(named.get(homes[0]), label.address, {
                    name: shown(label.name),
                    rank: [-label.scope.length, label.order],
                });
            }
        }

        // A `=` name an instruction uses as a memory operand is an address: its region's, if only that
        // region's code uses it, else a global.
        for (const source of sources) {
            const { assigns } = source.listing;
            const uses = new Map();
            for (const statement of source.listing.statements) {
                const base = statement.code ? operandBase(statement.operand) : null;
                const name = base ? source.resolve(statement.scope, base) : null;
                if (name && assigns.has(name) && !source.labelNames.has(name) && !this.systemNames.has(name)) {
                    if (!uses.has(name)) uses.set(name, []);
                    uses.get(name).push(statement);
                }
            }
            const order = new Map([...assigns.keys()].map((name, i) => [name, i]));
            for (const [name, statements] of uses) {
                const address = source.lookup(name);
                if (address === undefined || address < 0 || address >= AddressLimit) continue;
                const inside = regions.filter((region) => region.source === source && holds(region, address));
                if (inside.length === 1 && statements.every((statement) => runs(inside[0], statement)))
                    add(named.get(inside[0]), address, {
                        name: shown(name),
                        rank: [-assigns.get(name).length - 1, order.get(name)],
                    });
                else add(globalsNamed, address, { name: shown(name), rank: [statements.length, order.get(name)] });
            }
        }

        // One name per address: in a region, a scope's own name over the labels inside it, then the
        // label nearest the bytes (the last written); in the globals, the name most instructions use.
        const choose = (names, chosen, saying) => {
            for (const [address, entries] of names) {
                entries.sort(byRankDescending);
                chosen.set(entries[0].name, address);
                for (const { name } of entries.slice(1)) dropped.push([name, address, `${saying} ${entries[0].name}`]);
            }
        };
        for (const region of regions) choose(named.get(region), region.symbols, `${region.name} calls it`);
        const globals = new Map();
        choose(globalsNamed, globals, "the globals call it");

        const every = [...regions.flatMap((region) => [...region.symbols.keys()]), ...globals.keys()];
        const twice = [...new Set(every.filter((name, i) => every.indexOf(name) !== i))].sort();
        if (twice.length) throw new Error(`${spec.id}: names given twice: ${twice.join(", ")}`);

        const stores = sources.flatMap((source) => this.stores(spec, source));
        const spread = { bytesPerAnchor: this.config.bytesPerAnchor, spreadAnchors: this.config.spreadAnchors };
        for (const region of regions) {
            const { anchors, errors, notes, reasons } = chooseAnchors(region, stores, this.images, spread);
            region.anchors = anchors;
            this.errors.push(...errors);
            this.notes.push(...notes);
            this.reasons.push(...reasons);
        }
        return { json: this.json(spec, regions, globals), regions, dropped };
    }

    json(spec, regions, globals) {
        const { config } = this;
        return {
            format: Format,
            title: spec.title,
            licence: config.licence,
            source: `${config.source.repository}/tree/${config.source.commit}`,
            ...(config.notice !== undefined && { notice: config.notice }),
            ...(config.madeFrom !== undefined && { madeFrom: config.madeFrom }),
            regions: Object.fromEntries(
                regions.map((region) => [
                    region.name,
                    {
                        start: hexAddress(region.start),
                        end: hexAddress(region.end),
                        minAnchors: region.anchors.length,
                        anchors: region.anchors.map(({ at, data }) => ({
                            at: hexAddress(at),
                            bytes: Buffer.from(data).toString("hex"),
                        })),
                        symbols: byAddress(region.symbols),
                    },
                ]),
            ),
            globals: byAddress(globals),
        };
    }
}

/**
 * A title's sets from its baron build, as its config describes them.
 * @returns {{sets: {id: string, file: string, json: object, regions: object[], dropped: [string, number, string][]}[],
 *     errors: string[], notes: string[], reasons: string[]}}
 */
export function importBaron(config, build) {
    const importer = new Importer(config, build);
    const sets = config.sets.map((spec) => ({
        id: spec.id,
        file: `${config.id}-${spec.id}.json`,
        ...importer.set(spec),
    }));
    return { sets, errors: importer.errors, notes: importer.notes, reasons: importer.reasons };
}

/** Reads a curator's config and the build it names, checking the build is of the config's commit. */
export function loadTitle(configPath, buildDir) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    checkBuildCommit(config, buildDir);
    return { config, build: readBaronBuild(buildDir, config.build) };
}

/**
 * Checks the imported sets as the index will, and only if nothing failed replaces the title's set files
 * in `out` with them, every one formatted before any file is touched.
 * @returns {Promise<string[]>} the errors, the importer's and the index's, none if the sets were written
 */
export async function writeSets({ sets, errors }, { out, titleId, mosSets }) {
    const problems = [
        ...errors,
        ...sets.flatMap(({ file, json }) =>
            checkSet(json, { file: `sets/${file}`, mosSets }).map((problem) => `${file}: ${problem}`),
        ),
    ];
    if (problems.length) return problems;
    const formatted = [];
    for (const { file, json } of sets) {
        const target = path.join(out, file);
        formatted.push([target, await formatJson(json, target)]);
    }
    for (const stale of readdirSync(out).filter((name) => name.startsWith(`${titleId}-`) && name.endsWith(".json")))
        rmSync(path.join(out, stale));
    for (const [target, text] of formatted) writeFileSync(target, text);
    return [];
}

async function main() {
    const { values } = parseArgs({
        options: {
            config: { type: "string" },
            build: { type: "string" },
            out: { type: "string", default: SetsDir },
            verbose: { type: "boolean", short: "v", default: false },
        },
    });
    if (!values.config || !values.build) throw new Error("Usage: import-baron.js --config <file> --build <dir>");
    const { config, build } = loadTitle(values.config, values.build);
    const imported = importBaron(config, build);
    for (const { id, json, regions, dropped } of imported.sets) {
        const summary = regions.map((region) => `${region.name} ${region.anchors.length}/${region.symbols.size}`);
        console.log(
            `${id}: ${summary.join(", ")}; ${Object.keys(json.globals).length} globals (${dropped.length} names left out)`,
        );
        if (values.verbose)
            for (const [name, address, why] of dropped) console.log(`    left out ${name} ${hex(address)}: ${why}`);
    }
    if (values.verbose) for (const reason of imported.reasons) console.log(`    ${reason}`);
    for (const note of imported.notes) console.log(`note: ${note}`);
    const errors = await writeSets(imported, { out: values.out, titleId: config.id, mosSets: readMosSets() });
    if (errors.length) {
        for (const error of errors) console.error(`error: ${error}`);
        console.error("Nothing written");
        return 1;
    }
    console.log(`Wrote ${imported.sets.length} sets to ${values.out}`);
    return 0;
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
