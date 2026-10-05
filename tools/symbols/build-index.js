#!/usr/bin/env node
/**
 * Checks every symbol set under public/symbols/sets/ as the registry's build will, and writes
 * public/symbols/index.json from them: each set's location, licence and regions, without the
 * regions' symbols. The format is "Symbol sets" in docs/media-registry-proposal.md.
 *
 * Usage: node tools/symbols/build-index.js
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format as prettier, resolveConfig } from "prettier";

import { parseAddress, parseSet } from "../../src/symbol-sets.js";

export const SymbolsDir = fileURLToPath(new URL("../../public/symbols/", import.meta.url));
const SetsDir = "sets";
const IndexFile = "index.json";
const MosSetsFile = "mos-sets.json";

const Format = 1;
const MinAnchorBytes = 4;
const MaxAnchorBytes = 8;
const IoStart = 0xfc00;
const IoEnd = 0xff00;
const ImageKey = /^[0-9a-f]{32}$/;
const GplFamily = /GPL/i;

const hex = (address) => `&${address.toString(16).toUpperCase().padStart(4, "0")}`;
const isText = (value) => typeof value === "string" && value.length > 0;

/** Every set under `dir`, with its path relative to `dir` as the index gives it. */
export function readSets(dir = SymbolsDir) {
    return readdirSync(path.join(dir, SetsDir))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => {
            const file = `${SetsDir}/${name}`;
            return { file, json: JSON.parse(readFileSync(path.join(dir, file), "utf8")) };
        });
}

/** The sets that may be marked `system`, by their paths relative to `dir`. */
export function readMosSets(dir = SymbolsDir) {
    return JSON.parse(readFileSync(path.join(dir, MosSetsFile), "utf8"));
}

function checkNames(names, where, seen, problems) {
    const byAddress = new Map();
    for (const [name, address] of Object.entries(names ?? {})) {
        if (seen.has(name)) problems.push(`${name} is named in ${seen.get(name)} and again in ${where}`);
        seen.set(name, where);
        const value = parseAddress(address, name);
        if (byAddress.has(value))
            problems.push(`${hex(value)} has two names in ${where}, ${byAddress.get(value)} and ${name}`);
        byAddress.set(value, name);
    }
}

/**
 * What the build would reject in one set file: its schema and licence, its anchors' lengths,
 * places and number, `system` only on a set the MOS list names, and its names.
 * @returns {string[]} the problems, none for a good set
 */
export function checkSet(json, { file, mosSets }) {
    let set;
    try {
        set = parseSet(json);
    } catch (error) {
        return [error.message];
    }
    const problems = [];
    if (!isText(json.title)) problems.push("it has no title");
    if (!isText(json.licence)) problems.push("it has no licence");
    else if (GplFamily.test(json.licence))
        problems.push(`its licence is ${json.licence}, and names from GPL sources aren't used for sets`);
    if (!isText(json.source)) problems.push("it doesn't say where its names came from in source");
    if (json.notice !== undefined && !isText(json.notice)) problems.push("its notice isn't text");
    if (
        json.madeFrom !== undefined &&
        !(Array.isArray(json.madeFrom) && json.madeFrom.every((key) => ImageKey.test(key)))
    )
        problems.push("madeFrom isn't a list of image keys");
    if (json.link !== undefined) problems.push("it has a link, and linked sets aren't supported yet");
    if (json.system !== undefined && typeof json.system !== "boolean") problems.push("system isn't true or false");
    if (set.system && !mosSets.includes(file)) problems.push(`it's a system set, but ${MosSetsFile} doesn't list it`);
    if (set.regions.length === 0) problems.push("it has no regions");

    for (const region of set.regions) {
        const where = `region ${region.name}`;
        if (region.anchors.length > 0 && region.anchors.length < region.minAnchors)
            problems.push(`${where} has ${region.anchors.length} anchors, fewer than its minAnchors`);
        for (const { at, bytes } of region.anchors) {
            const end = at + bytes.length;
            if (bytes.length < MinAnchorBytes || bytes.length > MaxAnchorBytes)
                problems.push(
                    `${where}'s anchor at ${hex(at)} is ${bytes.length} bytes, not ${MinAnchorBytes} to ${MaxAnchorBytes}`,
                );
            if (at < region.start || end > region.end) problems.push(`${where}'s anchor at ${hex(at)} runs outside it`);
            if (at < IoEnd && end > IoStart)
                problems.push(`${where}'s anchor at ${hex(at)} reads ${hex(IoStart)}-${hex(IoEnd - 1)}`);
        }
        for (const [address, name] of region.symbols)
            if (address < region.start || address >= region.end)
                problems.push(`${where} names ${hex(address)} (${name}), which is outside it`);
    }

    const seen = new Map();
    checkNames(json.globals, "the globals", seen, problems);
    for (const [name, region] of Object.entries(json.regions ?? {}))
        checkNames(region.symbols, `region ${name}`, seen, problems);
    return problems;
}

/** The index the debugger fetches first, from the sets as `readSets` gives them. */
export function indexOf(sets) {
    return {
        format: Format,
        sets: sets.map(({ file, json }) => ({
            url: file,
            licence: json.licence,
            regions: Object.fromEntries(
                Object.entries(json.regions).map(([name, { symbols: _symbols, ...region }]) => [name, region]),
            ),
        })),
    };
}

/** JSON as `npm run format` would leave it at `file`. */
export async function formatJson(value, file) {
    const options = await resolveConfig(file, { editorconfig: true });
    return prettier(JSON.stringify(value), { ...options, filepath: file });
}

async function main() {
    const sets = readSets();
    const mosSets = readMosSets();
    const problems = sets.flatMap(({ file, json }) =>
        checkSet(json, { file, mosSets }).map((problem) => `${file}: ${problem}`),
    );
    if (problems.length) {
        console.error(problems.join("\n"));
        return 1;
    }
    const indexPath = path.join(SymbolsDir, IndexFile);
    writeFileSync(indexPath, await formatJson(indexOf(sets), indexPath));
    console.log(`Wrote ${IndexFile} with ${sets.length} sets`);
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
