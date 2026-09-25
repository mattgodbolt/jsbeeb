// Symbol-set anchors for the media registry proposal ("Symbols and source"), as a prototype:
// reads a py8dis disassembly listing, splits it into regions, and picks anchors, short runs of
// bytes at routine entry points that nothing in the listing writes to.
//
//   node tools/registry/anchors.js <listing.s> [--exclude-section 0x70a0] [--name <set>]
//       [--region 0x0d00=main ...] [--per-kb 0.5] [--min-anchors 2] [--max-anchors 8]
//       [--out <file.json>]

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const MinAnchorBytes = 4;
const MaxAnchorBytes = 8;
// A store through an indexed absolute address can reach this far past its base.
const IndexReach = 256;
const StoreMnemonics = new Set(["sta", "stx", "sty", "stz", "inc", "dec", "asl", "lsr", "rol", "ror", "trb", "tsb"]);
const RunEnders = new Set(["rts", "rti", "jmp"]);

const hex = (value, digits = 4) => `0x${value.toString(16).padStart(digits, "0")}`;
const parseNumber = (text) => (text.startsWith("$") ? parseInt(text.slice(1), 16) : parseInt(text, 10));

/**
 * Evaluates the operand expressions py8dis writes for xa: a symbol or number, optionally with a
 * `+n`/`-n` offset, and `<(...)`/`>(...)` for the low and high byte.
 */
export function evaluate(expression, symbols) {
    const text = expression.trim();
    const byteOf = /^([<>])\((.*)\)$/.exec(text);
    if (byteOf) {
        const value = evaluate(byteOf[2], symbols);
        return byteOf[1] === "<" ? value & 0xff : (value >> 8) & 0xff;
    }
    const sum = /^([A-Za-z_][\w]*|\$[0-9a-fA-F]+|\d+)\s*(?:([+-])\s*(\$[0-9a-fA-F]+|\d+))?$/.exec(text);
    if (!sum) throw new Error(`Can't evaluate operand expression "${expression}"`);
    const [, head, sign, offset] = sum;
    let value;
    if (/^[A-Za-z_]/.test(head)) {
        if (!symbols.has(head)) throw new Error(`Unknown symbol "${head}" in "${expression}"`);
        value = symbols.get(head);
    } else {
        value = parseNumber(head);
    }
    if (sign) value += (sign === "+" ? 1 : -1) * parseNumber(offset);
    return value;
}

function stringBytes(literal) {
    return [...literal.slice(1, -1)].map((c) => c.charCodeAt(0));
}

function splitOperands(text) {
    const parts = [];
    let current = "";
    let quoted = false;
    for (const c of text) {
        if (c === '"') quoted = !quoted;
        if (c === "," && !quoted) {
            parts.push(current.trim());
            current = "";
        } else current += c;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/**
 * Reads py8dis's xa-flavoured listing. Instruction bytes come from the `// addr: bytes` comment on each
 * line, data bytes from the `.byt` operands, so the listing needn't be assembled.
 * @returns {{sections: {start: number, end: number}[], bytes: Map<number, number>,
 *     instructions: {addr: number, bytes: number[], mnemonic: string, operand: string}[],
 *     labels: Map<string, number>, constants: Map<string, number>, references: Map<number, number>}}
 */
export function parsePy8disListing(text) {
    const sections = [];
    const bytes = new Map();
    const instructions = [];
    const labels = new Map();
    const constants = new Map();
    const references = new Map();
    const pendingData = [];
    let section = null;
    let pendingReferences = 0;
    let pc = 0;

    for (const rawLine of text.split("\n")) {
        const line = rawLine.replace(/\s+$/, "");
        const code = codeOf(line);
        const listed = /\/\/\s*([0-9a-f]{4}):\s*(.*)$/.exec(line);
        const referenced = /^\s*\/\/ Referenced (\d+) times? by/.exec(line);
        if (referenced) {
            pendingReferences = Number(referenced[1]);
            continue;
        }
        if (!code.trim()) continue;
        const org = /^\s*\*\s*=\s*(\$[0-9a-fA-F]+)$/.exec(code);
        if (org) {
            pc = parseNumber(org[1]);
            section = { start: pc, end: pc };
            sections.push(section);
            continue;
        }
        const equate = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(code.trim());
        if (equate) {
            constants.set(equate[1], parseNumber(equate[2].trim()));
            continue;
        }
        const label = /^([A-Za-z_]\w*):$/.exec(code.trim());
        if (label) {
            labels.set(label[1], pc);
            if (pendingReferences) references.set(pc, pendingReferences);
            pendingReferences = 0;
            continue;
        }
        if (!section) throw new Error(`Code before the first "* =" line: ${line}`);
        if (listed && parseInt(listed[1], 16) !== pc)
            throw new Error(`Listing says ${listed[1]} where the parse has reached ${hex(pc)}: ${line}`);
        const data = /^\s*\.byt\s+(.*)$/.exec(code);
        if (data) {
            const [operands, forced] = data[1].split(/\s;\s/);
            if (forced) {
                // py8dis spells an instruction it must force to absolute addressing as bytes, with the
                // instruction after a semicolon.
                const [mnemonic, operand = ""] = forced.trim().split(/\s+/, 2);
                const instructionBytes = listed[2].split(/\s+/).map((b) => parseInt(b, 16));
                instructions.push({
                    addr: pc,
                    bytes: instructionBytes,
                    mnemonic: mnemonic.replace(/\+\d$/, ""),
                    operand,
                });
                instructionBytes.forEach((b, i) => bytes.set(pc + i, b));
                pc += instructionBytes.length;
            } else {
                pendingData.push({ addr: pc, operands: splitOperands(operands) });
                for (const operand of splitOperands(operands)) pc += operand.startsWith('"') ? operand.length - 2 : 1;
            }
            section.end = pc;
            continue;
        }
        const instruction = /^\s+([a-z]{3})(?:\s+(.*))?$/.exec(code);
        if (!instruction || !listed) throw new Error(`Can't read listing line: ${line}`);
        const instructionBytes = listed[2].split(/\s+/).map((b) => parseInt(b, 16));
        instructions.push({
            addr: pc,
            bytes: instructionBytes,
            mnemonic: instruction[1],
            operand: instruction[2] ?? "",
        });
        instructionBytes.forEach((b, i) => bytes.set(pc + i, b));
        pc += instructionBytes.length;
        section.end = pc;
    }

    const symbols = new Map([...constants, ...labels]);
    for (const { addr, operands } of pendingData) {
        let at = addr;
        for (const operand of operands) {
            const values = operand.startsWith('"') ? stringBytes(operand) : [evaluate(operand, symbols) & 0xff];
            for (const value of values) bytes.set(at++, value);
        }
    }
    return { sections, bytes, instructions, labels, constants, references };
}

function codeOf(line) {
    let quoted = false;
    for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === '"') quoted = !quoted;
        if (!quoted && line[i] === "/" && line[i + 1] === "/") return line.slice(0, i);
    }
    return line;
}

/**
 * Every address a store in the listing can write, for every store whose target can be worked out from its
 * operand: a plain absolute store writes its operand (py8dis names self-modified operands as `label+1`, so
 * those land here too), an indexed one anywhere up to IndexReach bytes on. A store through a zero-page
 * pointer has no target that can be worked out, so it is counted and excludes nothing.
 */
export function storeTargets(listing, { excludeSections = [] } = {}) {
    const symbols = new Map([...listing.constants, ...listing.labels]);
    const inExcluded = (addr) =>
        listing.sections.some((s) => excludeSections.includes(s.start) && addr >= s.start && addr < s.end);
    const written = new Set();
    let indirect = 0;
    let indexed = 0;
    for (const { addr, mnemonic, operand } of listing.instructions) {
        if (!StoreMnemonics.has(mnemonic) || !operand || operand === "a" || inExcluded(addr)) continue;
        if (operand.startsWith("(")) {
            indirect++;
            continue;
        }
        const [base, index] = operand.split(",").map((part) => part.trim());
        const target = evaluate(base, symbols);
        const reach = index ? IndexReach : 1;
        if (index) indexed++;
        for (let i = 0; i < reach; i++) written.add(target + i);
    }
    return { written, indirect, indexed };
}

function occurrences(image, pattern) {
    let count = 0;
    outer: for (let i = 0; i + pattern.length <= image.length; i++) {
        for (let j = 0; j < pattern.length; j++) if (image[i + j] !== pattern[j]) continue outer;
        count++;
    }
    return count;
}

const isNop = (instruction) => instruction?.mnemonic === "nop";
const inNopRun = (byAddr, at) => isNop(byAddr.get(at)) && (isNop(byAddr.get(at - 1)) || isNop(byAddr.get(at + 1)));

/**
 * Every labelled instruction in a region that could anchor it: the whole instructions from the label
 * on, up to MaxAnchorBytes, stopping before any byte a store can reach and after an unconditional
 * transfer, and before a run of NOPs (padding that patches and cheats reuse). `pinned` says the run holds an absolute address inside one of the regions, so code moving
 * behind the anchor changes it too.
 */
export function anchorCandidates(listing, region, written, { regions = [region], respectWrites = true } = {}) {
    const byAddr = new Map(listing.instructions.map((i) => [i.addr, i]));
    const image = [];
    for (let a = region.start; a < region.end; a++) image.push(listing.bytes.get(a) ?? -1);
    const inRegions = (value) => regions.some((r) => value >= r.start && value < r.end);
    const labelled = new Set([...listing.labels.values()]);
    const candidates = [];
    for (const start of [...labelled].sort((a, b) => a - b)) {
        if (start < region.start || start >= region.end || !byAddr.has(start)) continue;
        const run = [];
        let pinned = false;
        for (let at = start; byAddr.has(at) && at < region.end;) {
            const instruction = byAddr.get(at);
            if (run.length + instruction.bytes.length > MaxAnchorBytes) break;
            if (inNopRun(byAddr, at)) break;
            if (respectWrites && instruction.bytes.some((_, i) => written.has(at + i))) break;
            run.push(...instruction.bytes);
            if (instruction.bytes.length === 3 && inRegions(instruction.bytes[1] | (instruction.bytes[2] << 8)))
                pinned = true;
            at += instruction.bytes.length;
            if (RunEnders.has(instruction.mnemonic)) break;
        }
        if (run.length < MinAnchorBytes) continue;
        if (occurrences(image, run) !== 1) continue;
        candidates.push({ at: start, bytes: run, pinned, references: listing.references.get(start) ?? 0 });
    }
    return candidates;
}

const score = (c) => (c.pinned ? 1e6 : 0) + c.references * 100 + c.bytes.length;

/**
 * Picks up to `count` anchors spread over the region's code: the best-scoring candidate in each equal
 * slice of the span from the first candidate to the last, topped up with the best of the rest when empty
 * slices leave fewer than `minimum`.
 */
export function chooseAnchors(candidates, count, minimum = 0) {
    if (!candidates.length) return [];
    const first = candidates[0].at;
    const chosen = [];
    const slice = (candidates.at(-1).at + 1 - first) / count;
    for (let i = 0; i < count; i++) {
        const from = first + i * slice;
        const to = from + slice;
        const inSlice = candidates.filter((c) => c.at >= from && c.at < to);
        if (inSlice.length) chosen.push(inSlice.reduce((best, c) => (score(c) > score(best) ? c : best)));
    }
    const rest = candidates.filter((c) => !chosen.includes(c)).sort((a, b) => score(b) - score(a));
    while (chosen.length < minimum && rest.length) chosen.push(rest.shift());
    return chosen.sort((a, b) => a.at - b.at);
}

export const bytesToHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
export const hexToBytes = (text) => text.match(/../g).map((pair) => parseInt(pair, 16));
export const parseAddress = (text) => (typeof text === "number" ? text : parseInt(text, 16));

/**
 * Whether each of a region's anchors is in memory, read through `readByte`. The region matches when all
 * of them do and there are at least `minAnchors`.
 */
export function checkRegion(region, readByte) {
    const results = region.anchors.map(({ at, bytes }) => {
        const address = parseAddress(at);
        return hexToBytes(bytes).every((b, i) => readByte(address + i) === b);
    });
    const needed = Math.max(1, region.minAnchors ?? 1);
    return { matched: results.length >= needed && results.every(Boolean), results };
}

/**
 * The symbol set: regions with their anchors in the proposal's shape, and the symbols themselves in
 * Baron's `--symbols` shape (one object of name to value), split into those inside a region and the
 * rest (zero page, OS entry points), which apply whenever any region does.
 */
export function buildSymbolSet(
    listing,
    { name, regionNames = {}, excludeSections = [], perKb = 0.5, minAnchors = 2, maxAnchors = 8 },
) {
    const { written, indirect, indexed } = storeTargets(listing, { excludeSections });
    const kept = listing.sections.filter((s) => !excludeSections.includes(s.start));
    const regions = {};
    const stats = { storesThroughPointers: indirect, indexedStores: indexed, writtenAddresses: written.size };
    for (const section of kept) {
        const regionName = regionNames[section.start] ?? `r${section.start.toString(16).padStart(4, "0")}`;
        const byLength = Math.round(((section.end - section.start) / 1024) * perKb);
        const count = Math.min(maxAnchors, Math.max(minAnchors, byLength));
        const candidates = anchorCandidates(listing, section, written, { regions: kept });
        const anchors = chooseAnchors(candidates, count, minAnchors);
        regions[regionName] = {
            start: hex(section.start),
            end: hex(section.end),
            minAnchors,
            anchors: anchors.map((a) => ({ at: hex(a.at), bytes: bytesToHex(a.bytes) })),
        };
        stats[regionName] = { candidates: candidates.length, pinned: candidates.filter((c) => c.pinned).length };
    }
    const inKept = (addr) => kept.some((s) => addr >= s.start && addr < s.end);
    const symbols = { regional: {}, global: {} };
    for (const [label, addr] of [...listing.labels].sort(([, a], [, b]) => a - b))
        (inKept(addr) ? symbols.regional : symbols.global)[label] = addr;
    for (const [label, value] of listing.constants) if (value > 0xff || !inKept(value)) symbols.global[label] = value;
    return { set: { [name]: { format: "baron-symbols", regions } }, symbols, stats };
}

function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            "exclude-section": { type: "string", multiple: true, default: [] },
            region: { type: "string", multiple: true, default: [] },
            name: { type: "string", default: "symbols" },
            "per-kb": { type: "string", default: "0.5" },
            "min-anchors": { type: "string", default: "2" },
            "max-anchors": { type: "string", default: "8" },
            out: { type: "string" },
        },
    });
    const listing = parsePy8disListing(readFileSync(positionals[0], "utf8"));
    const regionNames = Object.fromEntries(
        values.region.map((spec) => {
            const [at, regionName] = spec.split("=");
            return [parseAddress(at), regionName];
        }),
    );
    const result = buildSymbolSet(listing, {
        name: values.name,
        regionNames,
        excludeSections: values["exclude-section"].map(parseAddress),
        perKb: Number(values["per-kb"]),
        minAnchors: Number(values["min-anchors"]),
        maxAnchors: Number(values["max-anchors"]),
    });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, json);
    else process.stdout.write(json);
    console.error(JSON.stringify(result.stats));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
