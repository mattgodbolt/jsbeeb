#!/usr/bin/env node
/**
 * Makes a title's symbol sets from a py8dis disassembly: the title's control script, run under py8dis
 * by py8dis-dump.py, gives each piece of the binary where it runs, its instructions and data, and the
 * names the script chose. A curator's config under symbols-src/ says which pieces make a set and where
 * they're cut into regions; docs/symbol-importers.md says how the names and anchors are chosen.
 *
 * Usage: node tools/symbols/import-py8dis.js --config symbols-src/repton2.json [--source <checkout>]
 *            [--py8dis <checkout>] [--python <path>] [--out public/symbols/sets] [--verbose]
 *
 * Fetches the config's commits of the title's repository and of py8dis, or takes `--source` and
 * `--py8dis`, clean checkouts of them, and runs the script with `--python`, else $PYTHON, else
 * `python3`. Writes <config id>-<set id>.json for each set, then `node tools/symbols/build-index.js`
 * remakes the index. Refuses to write anything if a region can't be anchored, its anchors match another
 * of the binary's pieces, or a set fails the index's checks.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Format } from "../../src/symbol-sets.js";
import { chooseAnchors, storesIn } from "./anchor-chooser.js";
import { checkCommit, cloneCommit } from "./baron-build.js";
import { SymbolsDir } from "./build-index.js";
import { byAddress, evaluate, hexAddress, writeTitle } from "./import-baron.js";

const SetsDir = path.join(SymbolsDir, "sets");
const DumpScript = fileURLToPath(new URL("py8dis-dump.py", import.meta.url));
const Py8disPackage = "py8dis";
const MaxOutput = 64 * 1024 * 1024;

export const Py8disOptions = {
    source: { type: "string" },
    py8dis: { type: "string" },
    python: { type: "string" },
};
export const Py8disUsage = "[--source <checkout>] [--py8dis <checkout>] [--python <path>]";

const hex = (address) => `&${address.toString(16).toUpperCase().padStart(4, "0")}`;
const holds = (range, address) => address >= range.start && address < range.end;

/** An instruction's operand, which is what `tableSizes` gives an indexed store's table by. */
function operand({ code, data }) {
    if (!code || data.length < 2) return undefined;
    return data.length === 2 ? data[1] : data[1] | (data[2] << 8);
}

/**
 * A dump from py8dis-dump.py as the importer reads it: each piece where it runs, holding its own
 * statements and the labels py8dis put in it, and each name's address. A name given two addresses is
 * refused.
 */
export function readDump(dump) {
    const pieces = dump.pieces.map((piece, index) => {
        const read = {
            name: `piece ${index} (${hex(piece.runtime)})`,
            binary: piece.binary,
            start: piece.runtime,
            end: piece.runtime + piece.length,
            move: piece.move,
            labels: [],
        };
        read.statements = piece.statements.map(({ at, bytes, code }) => {
            const statement = { address: at, data: bytes, code, skip: false, section: read };
            statement.base = operand(statement);
            return statement;
        });
        return read;
    });
    const names = new Map();
    for (const label of dump.labels) {
        if (names.has(label.name) && names.get(label.name) !== label.address)
            throw new Error(
                `${label.name} names two addresses, ${hex(names.get(label.name))} and ${hex(label.address)}`,
            );
        names.set(label.name, label.address);
        const piece = pieces.find((p) => p.move === label.move && holds(p, label.address));
        if (piece) piece.labels.push({ address: label.address, name: label.name });
    }
    return { pieces, labels: dump.labels, names };
}

/** Everything the binary puts in memory: each piece where it runs, and the binary where it loads. */
function binaryImages(pieces) {
    const loaded = new Map();
    for (const piece of pieces) {
        let at = piece.binary;
        for (const { data } of piece.statements) for (const byte of data) loaded.set(at++, byte);
    }
    return [
        ...pieces.map((piece) => ({
            name: piece.name,
            memory: new Map(
                piece.statements.flatMap(({ address, data }) => data.map((byte, i) => [address + i, byte])),
            ),
            program: true,
        })),
        { name: "the binary as loaded", memory: loaded, program: false },
    ];
}

class Importer {
    constructor(config, dump) {
        this.config = config;
        this.dump = readDump(dump);
        this.images = binaryImages(this.dump.pieces);
        this.errors = [];
        this.notes = [];
        this.reasons = [];
    }

    find(name) {
        return this.dump.names.get(name);
    }

    region(spec, regionSpec) {
        const find = (name) => this.find(name);
        const start = evaluate(regionSpec.from, find);
        const pieces = this.dump.pieces.filter((piece) => holds(piece, start));
        if (pieces.length !== 1)
            throw new Error(
                `${spec.id}/${regionSpec.name}: ${pieces.length} pieces of the binary run at ${hex(start)}`,
            );
        const [piece] = pieces;
        const end = regionSpec.to === undefined ? piece.end : evaluate(regionSpec.to, find);
        if (end <= start || end > piece.end)
            throw new Error(`${spec.id}/${regionSpec.name}: ${hex(start)}-${hex(end)} isn't inside ${piece.name}`);
        const memory = new Map(
            piece.statements
                .flatMap(({ address, data }) => data.map((byte, i) => [address + i, byte]))
                .filter(([address]) => address >= start && address < end),
        );
        return {
            name: regionSpec.name,
            fullName: `${spec.id}/${regionSpec.name}`,
            imageName: piece.name,
            section: piece,
            sectionInfo: {
                org: piece.start,
                end: piece.end,
                exec: null,
                statements: piece.statements,
                labels: piece.labels,
            },
            start,
            end,
            overwritten: regionSpec.overwritten === true,
            avoid: (regionSpec.avoid ?? []).map(([from, to]) => [evaluate(from, find), evaluate(to, find)]),
            osBlocks: new Set(),
            memory,
            symbols: new Map(),
            anchors: [],
        };
    }

    /**
     * The binary's stores, with the config's table sizes and moving copies, each an expression that has
     * to match a store.
     */
    stores(spec) {
        const find = (name) => this.find(name);
        const tables = Object.entries(spec.tableSizes ?? {}).map(([table, size]) => [
            table,
            evaluate(table, find),
            evaluate(size, find),
        ]);
        const moves = (spec.moves ?? []).map((move) => [move, evaluate(move, find)]);
        const statements = this.dump.pieces.flatMap((piece) => piece.statements);
        const { stores, used } = storesIn(statements, {
            tableSizes: new Map(tables.map(([, address, size]) => [address, size])),
            moves: new Map(moves.map(([, address]) => [address, this.pieceRunning(address)])),
        });
        const unmatched = [...tables, ...moves].filter(([, address]) => !used.has(address)).map(([name]) => name);
        if (unmatched.length)
            throw new Error(`${spec.id}: a table or a move matches no store: ${unmatched.join(", ")}`);
        return stores;
    }

    /** The one piece with an instruction at `address`, else null, which leaves a copy loop there to any piece. */
    pieceRunning(address) {
        const pieces = this.dump.pieces.filter((piece) =>
            piece.statements.some((s) => s.code && s.address === address),
        );
        return pieces.length === 1 ? pieces[0] : null;
    }

    /** One set: its regions with their names and anchors, its globals, and the names left out. */
    set(spec) {
        const regions = spec.regions.map((regionSpec) => this.region(spec, regionSpec));
        const globals = new Map();
        const dropped = [];
        for (const { name, address, move } of this.dump.labels) {
            const inPiece = this.dump.pieces.some((piece) => piece.move === move && holds(piece, address));
            const region = regions.find((r) => r.section.move === move && holds(r, address));
            const names = region ? region.symbols : inPiece ? null : globals;
            if (!names) {
                dropped.push([name, address, "in no region"]);
                continue;
            }
            const taken = [...names].find(([, other]) => other === address);
            if (taken) {
                dropped.push([
                    name,
                    address,
                    `${region ? `${region.name} calls it` : "the globals call it"} ${taken[0]}`,
                ]);
                continue;
            }
            names.set(name, address);
        }

        const stores = this.stores(spec);
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
 * A title's sets from its py8dis dump, as its config describes them.
 * @returns {{sets: {id: string, file: string, json: object, regions: object[], dropped: [string, number, string][]}[],
 *     errors: string[], notes: string[], reasons: string[]}}
 */
export function importPy8dis(config, dump) {
    const importer = new Importer(config, dump);
    const sets = config.sets.map((spec) => ({
        id: spec.id,
        file: `${config.id}-${spec.id}.json`,
        ...importer.set(spec),
    }));
    return { sets, errors: importer.errors, notes: importer.notes, reasons: importer.reasons };
}

/**
 * Runs the config's control script under py8dis-dump.py, in `source.directory` (else the script's own),
 * with python started from a directory outside both checkouts.
 * @returns {object} the dump
 */
export function runPy8dis(config, { sourceDir, py8disDir, python, workDir }) {
    const { script, directory = path.dirname(script) } = config.source;
    const args = [DumpScript, path.join(py8disDir, Py8disPackage), path.join(sourceDir, directory)];
    try {
        const out = execFileSync(python, ["-I", "-B", ...args, path.join(sourceDir, script)], {
            cwd: workDir,
            encoding: "utf8",
            maxBuffer: MaxOutput,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return JSON.parse(out);
    } catch (error) {
        throw new Error(`py8dis failed on ${script}: ${error.stderr?.toString().trim() || error.message}`, {
            cause: error,
        });
    }
}

/**
 * Runs `use` with a curator's config and the dump of its title, made from the commits the config names.
 * @param {{source?: string, py8dis?: string, python?: string}} options - checkouts of the title's commit and
 *     py8dis's to use instead of fetching them, and the python to run (else PYTHON, else `python3`)
 */
export async function withPy8disTitle(configPath, options, use) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const python = options.python ?? process.env.PYTHON ?? "python3";
    const temp = mkdtempSync(path.join(tmpdir(), "symbols-py8dis-"));
    try {
        const sourceDir = options.source ?? path.join(temp, "source");
        if (options.source === undefined) cloneCommit(config.source, sourceDir);
        checkCommit(config.source, sourceDir);
        const py8disDir = options.py8dis ?? path.join(temp, "py8dis");
        if (options.py8dis === undefined) cloneCommit(config.py8dis, py8disDir);
        checkCommit(config.py8dis, py8disDir);
        const dump = runPy8dis(config, { sourceDir, py8disDir, python, workDir: temp });
        return await use({ config, dump, sourceDir });
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}

async function main() {
    const { values } = parseArgs({
        options: {
            config: { type: "string" },
            ...Py8disOptions,
            out: { type: "string", default: SetsDir },
            verbose: { type: "boolean", short: "v", default: false },
        },
    });
    if (!values.config) throw new Error(`Usage: import-py8dis.js --config <file> ${Py8disUsage}`);
    return withPy8disTitle(values.config, values, ({ config, dump }) => {
        console.log(`Ran ${config.source.script} under py8dis ${config.py8dis.commit}`);
        return writeTitle(config, importPy8dis(config, dump), values);
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
