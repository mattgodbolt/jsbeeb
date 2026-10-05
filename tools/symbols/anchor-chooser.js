/**
 * Chooses a symbol set's anchors from what an importer read out of a build: each region's statements,
 * labels and bytes, the stores the program's code makes, and every image the build puts in memory.
 * docs/symbol-importers.md gives the rules; the format is "Symbol sets" in
 * docs/media-registry-proposal.md.
 *
 * @typedef {object} ChooserStatement
 * @property {number} address - where it runs
 * @property {number[]} data
 * @property {boolean} code - an instruction, rather than data
 * @property {boolean} skip - padding (SKIP or SKIPTO), which holds whatever was in memory
 * @property {object | null} section - which section it's in, compared by identity
 * @property {number | undefined} [base] - for an instruction, the address its operand's name is built on
 *
 * @typedef {object} ChooserSection
 * @property {number} org
 * @property {number} end
 * @property {number | null} exec - the exec address it's saved with, if it says
 * @property {ChooserStatement[]} statements - its own, not those of sections inside it
 * @property {{address: number, name: string}[]} labels - every label assembled in it
 *
 * @typedef {object} ChooserRegion
 * @property {string} name
 * @property {string} fullName - set/region, for messages
 * @property {string} imageName - the name its section's image has among the build's images
 * @property {object} section - compared by identity with a statement's
 * @property {ChooserSection} sectionInfo
 * @property {number} start
 * @property {number} end
 * @property {boolean} overwritten - run-once code that other code writes over
 * @property {[number, number][]} avoid - [from, to) ranges no anchor may cover
 * @property {Set<number>} osBlocks - blocks the source hands the OS (LDX #LO(block)), by address
 * @property {Map<number, number>} memory - its bytes as loaded, address to byte
 *
 * @typedef {{name: string, memory: Map<number, number>, program: boolean}} Image - what the build puts in
 *     memory, with `program` true for a section of a program that makes a set
 *
 * @typedef {{at: number, data: number[], labelled: boolean, code: boolean}} Candidate
 * @typedef {{statement: ChooserStatement, first: number, last: number}} Store
 */

export const MinAnchorBytes = 4;
export const TargetAnchorBytes = 6;
export const MaxAnchorBytes = 8;
const MinDistinctBytes = 4;
const IoStart = 0xfc00;
const IoEnd = 0xff00;
const MosStart = 0xc000;
const OpcodeJsr = 0x20;
const OpcodeJmp = 0x4c;
const OpcodeNop = 0xea;
const IndexedReach = 0x100;
const ZeroPageEnd = 0x100;
// An OSFILE block, the longest the OS writes back.
const OsBlockMost = 18;
// BASIC II's entry, a saved BASIC program's exec address.
const BasicExec = 0x8023;
// An exec address in the I/O processor, whatever its top 16 bits.
const IoAddressMask = 0xffff;
const BasicLineLength = 3;
const BasicLineText = 4;
const BasicLineNumberLimit = 0x80;
const Cr = 0x0d;
const Quote = 0x22;
const TokenRem = 0xf4;

const ZeroPage = "zp";
const ZeroPageIndexed = "zp,i";
const Absolute = "abs";
const AbsoluteIndexed = "abs,i";

/** Stores and read-modify-writes whose target the instruction names, by opcode. */
const StoreModes = new Map([
    [0x85, ZeroPage],
    [0x95, ZeroPageIndexed],
    [0x8d, Absolute],
    [0x9d, AbsoluteIndexed],
    [0x99, AbsoluteIndexed],
    [0x86, ZeroPage],
    [0x96, ZeroPageIndexed],
    [0x8e, Absolute],
    [0x84, ZeroPage],
    [0x94, ZeroPageIndexed],
    [0x8c, Absolute],
]);
for (const opcode of [0x06, 0x26, 0x46, 0x66, 0xc6, 0xe6]) {
    StoreModes.set(opcode, ZeroPage);
    StoreModes.set(opcode + 0x10, ZeroPageIndexed);
    StoreModes.set(opcode + 0x08, Absolute);
    StoreModes.set(opcode + 0x18, AbsoluteIndexed);
}

/** How a label names dead code, or bytes a file was saved with that aren't the program. */
const NotTheProgram = /(^|_)(unused|leftover|junk|spare|stray)(_|$)/;

const holds = (region, address) => address >= region.start && address < region.end;
const runs = (region, statement) => statement.section === region.section && holds(region, statement.address);
const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

/**
 * Every store whose target the code gives, with how far it reaches: 256 bytes for an indexed one,
 * unless `tableSizes` gives its table's size, and none for a copy in `moves` that puts the program in
 * place.
 * @param {ChooserStatement[]} statements - every statement of the program's code
 * @param {{tableSizes: Map<number, number>, moves: Set<number>}} options - tables by address, moves by
 *     the address of their store
 * @returns {{stores: Store[], used: Set<number>}} the stores, and which tables and moves they matched
 */
export function storesIn(statements, { tableSizes, moves }) {
    const out = [];
    const used = new Set();
    for (const statement of statements) {
        if (!statement.code || !StoreModes.has(statement.data[0])) continue;
        if (moves.has(statement.address)) {
            used.add(statement.address);
            continue;
        }
        const mode = StoreModes.get(statement.data[0]);
        const target = statement.data.length === 2 ? statement.data[1] : statement.data[1] | (statement.data[2] << 8);
        if (mode === ZeroPage || mode === Absolute) {
            out.push({ statement, first: target, last: target });
        } else if (statement.base !== undefined && tableSizes.has(statement.base)) {
            used.add(statement.base);
            out.push({ statement, first: target, last: target + tableSizes.get(statement.base) - 1 });
        } else if (mode === ZeroPageIndexed) {
            out.push({ statement, first: 0, last: ZeroPageEnd - 1 });
        } else {
            out.push({ statement, first: target, last: target + IndexedReach - 1 });
        }
    }
    return { stores: out, used };
}

/** A BASIC program's line headers, its first line and its REMs' text, but for any code in a REM. */
function basicLineStarts(region) {
    const section = region.sectionInfo;
    if (section.exec === null || (section.exec & IoAddressMask) !== BasicExec) return [];
    const code = new Set(
        section.statements.filter((s) => s.code).flatMap((s) => range(s.address, s.address + s.data.length)),
    );
    const memory = region.memory;
    const out = [];
    let line = section.org;
    while (memory.get(line) === Cr && (memory.get(line + 1) ?? 0xff) < BasicLineNumberLimit) {
        const length = memory.get(line + BasicLineLength);
        if (length === undefined) break;
        const end = line + length;
        out.push(...range(line, line === section.org ? end : line + BasicLineText));
        let quoted = false;
        for (let address = line + BasicLineText; address < end; address++) {
            if (memory.get(address) === Quote) quoted = !quoted;
            if (memory.get(address) === TokenRem && !quoted) {
                out.push(...range(address, end).filter((a) => !code.has(a)));
                break;
            }
        }
        line = end;
    }
    return out;
}

/**
 * Blocks the code hands to the OS, which OSWORD, OSFILE and OSGBPB write results back into: from the
 * block's label to the next label that starts code or another block, OsBlockMost bytes at most.
 */
function osBlocks(region) {
    const section = region.sectionInfo;
    const code = new Set(section.statements.filter((s) => s.code).map((s) => s.address));
    const stops = [
        ...new Set([
            ...section.labels
                .map(({ address }) => address)
                .filter((address) => code.has(address) || region.osBlocks.has(address)),
            section.end,
        ]),
    ].sort((a, b) => a - b);
    const out = [];
    for (const first of [...region.osBlocks].filter((at) => holds(region, at)).sort((a, b) => a - b)) {
        const end = Math.min(
            stops.find((stop) => stop > first),
            first + OsBlockMost,
        );
        out.push(...range(first, end));
    }
    return out;
}

/** @returns {Set<number>} the addresses in the region no anchor may cover */
export function blockedAddresses(region, stores) {
    const out = new Set();
    const add = (addresses) => addresses.forEach((address) => out.add(address));
    for (const store of stores) {
        // What overwrites run-once code is why its anchors are there.
        if (region.overwritten && !runs(region, store.statement)) continue;
        add(range(Math.max(store.first, region.start), Math.min(store.last + 1, region.end)));
    }
    for (const [from, to] of region.avoid) add(range(from, to));
    add(range(Math.max(region.start, IoStart), Math.min(region.end, IoEnd)));
    for (const statement of region.sectionInfo.statements)
        if (statement.skip) add(range(statement.address, statement.address + statement.data.length));
    add(basicLineStarts(region));
    add(osBlocks(region));
    const labels = region.sectionInfo.labels
        .filter(({ address }) => holds(region, address))
        .sort((a, b) => a.address - b.address || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    labels.forEach(({ address, name }, i) => {
        if (!name.split(".").some((part) => NotTheProgram.test(part))) return;
        const following = labels.slice(i + 1).find((label) => label.address > address);
        add(range(address, following ? following.address : region.end));
    });
    return out;
}

const callsOs = (statement) =>
    (statement.data[0] === OpcodeJsr || statement.data[0] === OpcodeJmp) &&
    statement.data.length === 3 &&
    (statement.data[1] | (statement.data[2] << 8)) >= MosStart;

const hasNopPair = (data) => data.some((byte, i) => byte === OpcodeNop && data[i + 1] === OpcodeNop);

/** The region's bytes from its start, with 0 where nothing is loaded. */
const regionBytes = (region) => Buffer.from(range(region.start, region.end).map((a) => region.memory.get(a) ?? 0));

/** How many times `data` appears in `bytes`, overlaps counted. */
function occurrences(bytes, data) {
    const needle = Buffer.from(data);
    let count = 0;
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) count++;
    return count;
}

/**
 * Every run of 4 to 8 bytes that could be an anchor: whole instructions from an instruction's start,
 * or data from any byte.
 * @returns {Candidate[]}
 */
export function candidates(region, blocked) {
    const statements = region.sectionInfo.statements
        .filter((s) => holds(region, s.address))
        .sort((a, b) => a.address - b.address);
    const labelled = new Set(region.sectionInfo.labels.map(({ address }) => address));
    const bytes = regionBytes(region);
    const starts = statements.flatMap((s, i) =>
        s.code ? [[s.address, i, 0]] : s.data.map((_, k) => [s.address + k, i, k]),
    );
    const out = [];
    for (const [at, first, firstOffset] of starts) {
        let data = [];
        let code = false;
        for (let i = first, k = firstOffset; data.length < TargetAnchorBytes && i < statements.length; i++, k = 0) {
            const s = statements[i];
            if (s.address + k !== at + data.length || s.skip) break;
            if (s.code) {
                if (data.length + s.data.length > MaxAnchorBytes) break;
                data.push(...s.data);
                code = true;
                if (callsOs(s)) {
                    data = [];
                    break;
                }
            } else {
                data.push(...s.data.slice(k, k + TargetAnchorBytes - data.length));
            }
        }
        if (data.length < MinAnchorBytes || new Set(data).size < MinDistinctBytes) continue;
        if (range(at, at + data.length).some((address) => blocked.has(address) || !holds(region, address))) continue;
        // Where cheats poke.
        if (code && hasNopPair(data)) continue;
        if (occurrences(bytes, data) > 1) continue;
        out.push({ at, data, labelled: labelled.has(at), code });
    }
    return out;
}

/** A routine's entry first, then code, then the most distinct bytes. */
const score = (candidate) => [
    candidate.labelled ? 1 : 0,
    candidate.code ? 1 : 0,
    Math.min(new Set(candidate.data).size, TargetAnchorBytes),
    candidate.data.length >= TargetAnchorBytes ? 1 : 0,
];

const compareScores = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
};

const covers = (a, b) => a.at < b.at + b.data.length && b.at < a.at + a.data.length;
const failsOn = (candidate, memory) =>
    candidate.data.some((byte, i) => memory.has(candidate.at + i) && memory.get(candidate.at + i) !== byte);
const heldBy = (candidate, memory) => candidate.data.every((_, i) => memory.has(candidate.at + i));

/**
 * The region's anchors: about one per `bytesPerAnchor` of it, `spreadAnchors` at most, spread over it;
 * then, for every other image of its addresses, one where that image differs if it would otherwise
 * hold all the anchors, or if it's another program's.
 * @param {ChooserRegion} region
 * @param {Store[]} stores
 * @param {Image[]} images
 * @param {{bytesPerAnchor: number, spreadAnchors: number}} spread
 * @returns {{anchors: Candidate[], errors: string[], notes: string[], reasons: string[]}}
 */
export function chooseAnchors(region, stores, images, { bytesPerAnchor, spreadAnchors }) {
    const errors = [];
    const notes = [];
    const reasons = [];
    const pool = candidates(region, blockedAddresses(region, stores));
    if (!pool.length) return { anchors: [], errors: [`${region.fullName}: nothing to anchor on`], notes, reasons };
    const chosen = [];
    const take = (options) => {
        const best = options.reduce((a, b) => (compareScores(score(b), score(a)) > 0 ? b : a));
        chosen.push(best);
    };
    const free = (candidate) => !chosen.some((other) => covers(candidate, other));

    const size = region.end - region.start;
    const count = Math.max(1, Math.min(spreadAnchors, Math.ceil(size / bytesPerAnchor)));
    const width = size / count;
    for (let slot = 0; slot < count; slot++) {
        const here = pool.filter(
            (c) => region.start + slot * width <= c.at && c.at < region.start + (slot + 1) * width && free(c),
        );
        if (here.length) take(here);
    }

    for (const { name, memory, program } of images) {
        if (name === region.imageName) continue;
        const overlap = [...region.memory.keys()].filter((address) => memory.has(address));
        if (!overlap.length || overlap.every((address) => memory.get(address) === region.memory.get(address))) continue;
        const collides = chosen.every((c) => heldBy(c, memory) && !failsOn(c, memory));
        const covered = chosen.some((c) => failsOn(c, memory));
        if (covered || !(collides || program)) continue;
        const telling = pool.filter((c) => failsOn(c, memory) && free(c));
        if (telling.length) {
            take(telling);
            reasons.push(`${region.fullName}: an anchor at ${hex(chosen.at(-1).at)} for ${name}`);
        } else if (collides) {
            errors.push(`${region.fullName}: its anchors all match ${name}`);
        } else {
            notes.push(`${region.fullName}: no anchor where ${name} differs`);
        }
    }
    return { anchors: chosen.sort((a, b) => a.at - b.at), errors, notes, reasons };
}

const hex = (address) => `&${address.toString(16).toUpperCase().padStart(4, "0")}`;
