#!/usr/bin/env node
/**
 * Makes a ROM's symbol set from an acornaeology disassembly's JSON (dasmos's schema 4): the labels of
 * its items, in regions anchored on the ROM in public/roms/, and its labels outside the ROM in the
 * config's `globals` ranges. A curator's config under symbols-src/ names the repository's commit, the
 * JSON, the ROM and the regions; docs/symbol-importers.md says how the names are chosen.
 *
 * Usage: node tools/symbols/import-acornaeology.js --config symbols-src/bbc-basic-2.json [--verbose]
 *            && node tools/symbols/build-index.js
 *
 * Fetches the JSON and the licence at the config's commit, and the config's `home` page, whose anchors
 * the names link to. Refuses to write the set if the JSON's bytes aren't the ROM's, if a region can't be
 * anchored, if its anchors all match another ROM in public/roms/, if the page has no anchor for a name
 * in the ROM, or if the set fails the index's checks.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Format, parseAddress, parseSet } from "../../src/symbol-sets.js";
import { chooseAnchors } from "./anchor-chooser.js";
import { checkSet, formatJson, readMosSets, SymbolsDir } from "./build-index.js";

const Importer = "acornaeology";
const SchemaVersion = 4;
const RomsDir = fileURLToPath(new URL("../../public/roms/", import.meta.url));
const KeyHexDigits = 32;
const AddressLimit = 0x10000;
const AddressAnchor = /\bid="(addr-([0-9A-Fa-f]{4}))"/g;

const hexAddress = (address) => `0x${address.toString(16).padStart(4, "0")}`;
const hex = (address) => `&${address.toString(16).toUpperCase().padStart(4, "0")}`;
const within = (ranges, address) => ranges.some(({ start, end }) => address >= start && address < end);

const parseRange = ({ start, end }, what) => ({
    start: parseAddress(start, `${what}'s start`),
    end: parseAddress(end, `${what}'s end`, AddressLimit),
});

/**
 * What the importer reads from a disassembly's JSON: where the ROM runs, its statements and labels,
 * and the names it gives addresses outside the ROM, each with whether its memory map describes it.
 * @returns {{base: number, end: number, statements: {address: number, data: number[], code: boolean}[],
 *     labels: {address: number, name: string}[], outside: {address: number, name: string, mapped: boolean}[]}}
 */
export function readDisassembly(json) {
    if (json?.meta?.schema_version !== SchemaVersion)
        throw new Error(`The disassembly has schema version ${json?.meta?.schema_version}, not ${SchemaVersion}`);
    const statements = json.items.map((item) => ({ address: item.addr, data: item.bytes, code: item.type === "code" }));
    const labels = json.items.flatMap((item) => (item.labels ?? []).map((name) => ({ address: item.addr, name })));
    const mapped = new Set(json.memory_map.map(({ name }) => name));
    const outside = Object.entries(json.external_labels).map(([name, address]) => ({
        address,
        name,
        mapped: mapped.has(name),
    }));
    return { base: json.meta.load_addr, end: json.meta.end_addr, statements, labels, outside };
}

/**
 * The anchors a disassembly's page has for addresses, `id="addr-800E"`, each id by its address.
 * @returns {Map<number, string>}
 */
export function pageAnchors(html) {
    return new Map([...html.matchAll(AddressAnchor)].map(([, id, digits]) => [parseInt(digits, 16), id]));
}

/** Every bank the ROM's size of the other images, placed where the ROM runs. */
function imagesOf(otherRoms, base, size) {
    return otherRoms.flatMap(({ name, bytes }) =>
        Array.from({ length: Math.floor(bytes.length / size) }, (_, bank) => ({
            name: bytes.length > size ? `${name} bank ${bank}` : name,
            memory: new Map(Array.from({ length: size }, (_, i) => [base + i, bytes[bank * size + i]])),
            program: false,
        })),
    );
}

/** One name per address outside the ROM: the one the memory map describes, else the only one. */
function globalsOf(outside, ranges, systemGlobals, dropped, errors) {
    const named = new Map();
    for (const label of outside) {
        if (!within(ranges, label.address)) continue;
        if (systemGlobals.has(label.address)) {
            dropped.push([label.name, label.address, `the system sets call it ${systemGlobals.get(label.address)}`]);
            continue;
        }
        if (!named.has(label.address)) named.set(label.address, []);
        named.get(label.address).push(label);
    }
    const globals = new Map();
    for (const [address, labels] of named) {
        const mapped = labels.filter((label) => label.mapped);
        const chosen = labels.length === 1 ? labels[0] : mapped.length === 1 ? mapped[0] : undefined;
        if (!chosen) {
            errors.push(`${hex(address)} has names ${labels.map(({ name }) => name).join(", ")} and none to prefer`);
            continue;
        }
        globals.set(chosen.name, address);
        for (const { name } of labels)
            if (name !== chosen.name) dropped.push([name, address, `the memory map calls it ${chosen.name}`]);
    }
    return globals;
}

const byAddress = (names) =>
    Object.fromEntries([...names].sort(([, a], [, b]) => a - b).map(([name, address]) => [name, hexAddress(address)]));

/**
 * A ROM's set from its disassembly, as the config describes it.
 * @param {object} config - the curator's config
 * @param {ReturnType<typeof readDisassembly>} disassembly
 * @param {object} options
 * @param {Uint8Array} options.rom - the ROM the set is anchored on
 * @param {{name: string, bytes: Uint8Array}[]} options.otherRoms - images whose banks the anchors must tell apart
 * @param {Map<number, string>} options.systemGlobals - addresses the system sets name, which the set leaves to them
 * @param {string} options.notice
 * @param {Map<number, string>} [options.anchors] - the ids the config's `home` page has for addresses
 *     (pageAnchors), to link each name with one to it
 * @returns {{json: object, errors: string[], notes: string[], dropped: [string, number, string][]}}
 */
export function importAcornaeology(config, disassembly, { rom, otherRoms, systemGlobals, notice, anchors = null }) {
    const { base, end, statements, labels, outside } = disassembly;
    const errors = [];
    const notes = [];
    const dropped = [];
    if (rom.length !== end - base)
        return {
            json: null,
            errors: [`${config.rom} is ${rom.length} bytes, the disassembly ${end - base}`],
            notes,
            dropped,
        };
    for (const { address, data } of statements)
        if (data.some((byte, i) => rom[address - base + i] !== byte))
            errors.push(`The disassembly's bytes at ${hex(address)} aren't ${config.rom}'s`);
    if (errors.length) return { json: null, errors, notes, dropped };

    const section = {};
    const sectionInfo = { org: base, end, exec: null, statements, labels };
    const memory = new Map(Array.from(rom, (byte, i) => [base + i, byte]));
    const images = imagesOf(otherRoms, base, rom.length);
    const spread = { bytesPerAnchor: config.bytesPerAnchor, spreadAnchors: config.spreadAnchors };
    const regions = config.regions.map((spec) => {
        const { start, end: regionEnd } = parseRange(spec, `region ${spec.name}`);
        const region = {
            name: spec.name,
            fullName: `${config.id}/${spec.name}`,
            imageName: config.rom,
            section,
            sectionInfo,
            start,
            end: regionEnd,
            overwritten: false,
            avoid: [],
            osBlocks: new Set(),
            memory: new Map([...memory].filter(([address]) => address >= start && address < regionEnd)),
        };
        const chosen = chooseAnchors(region, [], images, spread);
        errors.push(...chosen.errors);
        notes.push(...chosen.notes);
        const symbols = new Map(
            labels.filter(({ address }) => address >= start && address < regionEnd).map((l) => [l.name, l.address]),
        );
        return { ...region, anchors: chosen.anchors, symbols };
    });
    for (const { address, name } of labels)
        if (!within(regions, address)) dropped.push([name, address, "no region holds it"]);
    const globalRanges = config.globals.map((range, i) => parseRange(range, `globals range ${i}`));
    const globals = globalsOf(outside, globalRanges, systemGlobals, dropped, errors);
    for (const { address, name } of outside)
        if (!within(globalRanges, address)) dropped.push([name, address, "it's outside the globals' ranges"]);

    const page = anchors && new URL(config.home);
    const pageName = page && path.posix.basename(page.pathname);
    const places = new Map();
    if (anchors) {
        for (const [name, address] of [...globals, ...regions.flatMap((region) => [...region.symbols])])
            if (anchors.has(address)) places.set(name, `${pageName}#${anchors.get(address)}`);
        const unanchored = regions.flatMap((region) => [...region.symbols.keys()]).filter((name) => !places.has(name));
        if (unanchored.length) errors.push(`${config.home} has no anchor for ${unanchored.sort().join(", ")}`);
    }
    const { repository, commit, disassembly: file } = config.source;
    const json = {
        format: Format,
        title: config.title,
        licence: config.licence,
        source: `${repository}/blob/${commit}/${file}`,
        notice,
        madeFrom: [createHash("sha256").update(rom).digest("hex").slice(0, KeyHexDigits)],
        ...(config.home !== undefined && { home: config.home }),
        ...(anchors && { nameLink: `${new URL(".", page)}{place}` }),
        globals: byAddress(globals),
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
        ...(anchors && { places: Object.fromEntries([...places].sort(([a], [b]) => (a < b ? -1 : 1))) }),
    };
    return { json, errors, notes, dropped };
}

async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetching ${url} failed with ${response.status}`);
    return response.text();
}

/** Every file under public/roms/ that holds one or more whole banks the ROM's size, but the ROM. */
function otherRomsThan(romFile, size) {
    const files = readdirSync(RomsDir, { recursive: true })
        .map(String)
        .filter((name) => name !== romFile && statSync(path.join(RomsDir, name)).isFile())
        .sort();
    return files
        .map((name) => ({ name, bytes: readFileSync(path.join(RomsDir, name)) }))
        .filter(({ bytes }) => bytes.length > 0 && bytes.length % size === 0);
}

function systemGlobalsOf() {
    const globals = new Map();
    for (const file of readMosSets())
        for (const [address, name] of parseSet(JSON.parse(readFileSync(path.join(SymbolsDir, file), "utf8"))).globals)
            globals.set(address, name);
    return globals;
}

async function main() {
    const { values } = parseArgs({
        options: { config: { type: "string" }, verbose: { type: "boolean", short: "v", default: false } },
    });
    if (!values.config) throw new Error("Usage: import-acornaeology.js --config <file> [--verbose]");
    const config = JSON.parse(readFileSync(values.config, "utf8"));
    if (config.importer !== Importer) throw new Error(`${values.config} isn't a config for the ${Importer} importer`);
    const { repository, commit, disassembly: file, licenceFile } = config.source;
    const raw = `${repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${commit}`;
    const [disassemblyText, licence, page] = await Promise.all([
        fetchText(`${raw}/${file}`),
        fetchText(`${raw}/${licenceFile}`),
        config.home === undefined ? null : fetchText(config.home),
    ]);
    const disassembly = readDisassembly(JSON.parse(disassemblyText));
    const rom = readFileSync(path.join(RomsDir, config.rom));
    const notice = `The names are acornaeology's, from ${repository}/tree/${commit}, under this licence:\n\n${licence.trim()}`;
    const { json, errors, notes, dropped } = importAcornaeology(config, disassembly, {
        rom,
        otherRoms: otherRomsThan(config.rom, rom.length),
        systemGlobals: systemGlobalsOf(),
        notice,
        anchors: page === null ? null : pageAnchors(page),
    });
    const setFile = `sets/${config.id}.json`;
    const problems = [...errors, ...(json ? checkSet(json, { file: setFile, mosSets: readMosSets() }) : [])];
    if (values.verbose)
        for (const [name, address, why] of dropped) console.log(`    left out ${name} ${hex(address)}: ${why}`);
    for (const note of notes) console.log(`note: ${note}`);
    if (problems.length) {
        for (const problem of problems) console.error(`error: ${problem}`);
        console.error("Nothing written");
        return 1;
    }
    const target = path.join(SymbolsDir, setFile);
    writeFileSync(target, await formatJson(json, target));
    const summary = Object.entries(json.regions).map(
        ([name, region]) => `${name} ${region.anchors.length}/${Object.keys(region.symbols).length}`,
    );
    console.log(
        `Wrote ${setFile}: ${summary.join(", ")}; ${Object.keys(json.globals).length} globals (${dropped.length} names left out)`,
    );
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
