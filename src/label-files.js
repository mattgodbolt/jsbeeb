/**
 * Label files from assemblers and other emulators, naming addresses for the debugger alongside the symbol
 * sets. The formats, as their writers write them:
 *
 * - BeebAsm's `-d` or `-dd`, alone or with `-labels <file>`: `[{'start':6400L,'.loop':6402L}]`, in decimal,
 *   with `-dd`'s names as dotted scopes (`._0.inner`); SymbolTable::Dump in
 *   https://github.com/stardot/beebasm/blob/5d5d9405ef5e017a041871839d47aec3b1577bff/src/symboltable.cpp
 * - VICE's `save_labels`, `al C:1900 .start` (mon_save_symbols in
 *   https://github.com/VICE-Team/svn-mirror/blob/b8f6bc233c32b1d1e9d5a7d558e684cd860b1eb0/vice/src/monitor/monitor.c),
 *   and cc65's `-Ln`, `al 001900 .start`; another memory space than the computer's is a disc drive's.
 * - b-em's `simplesym`, `start=$1900`, `&1900`, `1900` or `F:8000` for ROM bank F (simplesym and
 *   dbg_parse_addr in https://github.com/stardot/b-em/blob/fbe85339ac4ac565f4bb65e5aae7998eb71a5632/src/debugger.c
 *   and src/6502.c), which ignores what follows the address.
 */
import { isHttps } from "./symbol-sets.js";

const SidewaysStart = 0x8000;
const SidewaysEnd = 0xc000;
const LastAddress = 0xffff;
// The highest BeebAsm label: its PC after a byte at $ffff, which names no byte.
const BeebAsmEnd = 0x10000;
const QuotedLength = 40;

const BeebAsmFile = /^\[\{([\s\S]*)\}\]$/;
// BeebAsm's Dump, as its source is now, writes no comma between -d's list and -dd's.
const BeebAsmEntry = /\s*,?\s*'([^']*)'\s*:\s*(\d+)L?/y;
const ViceLine = /^al\s+(?:([0-9a-z]+):)?([0-9a-f]+)\s+\.?(\S+)$/i;
const ViceComputerSpace = "C";
const AssignmentLine = /^([^=\s][^=]*?)\s*=\s*([^;]*?)\s*(?:;.*)?$/;
const BemValue = /^(?:[$&]([0-9a-f]+)|(?:([0-9a-f]):)?([0-9a-f]+))$/i;
const CommentLine = /^\s*(?:[;#].*)?$/;

/** @typedef {{name: string, address: number, bank: number | null}} Label - `bank` for a b-em `bank:address` */

const quoted = (text) => `"${text.length > QuotedLength ? `${text.slice(0, QuotedLength)}...` : text}"`;

function checkedAddress(value, where) {
    if (!(value <= LastAddress)) throw new Error(`${where} has the address ${value}, past $ffff`);
    return value;
}

/** @returns {Label[]} */
function beebAsmLabels(body) {
    const labels = [];
    let consumed = 0;
    BeebAsmEntry.lastIndex = 0;
    for (let match; (match = BeebAsmEntry.exec(body)); consumed = BeebAsmEntry.lastIndex) {
        const [, name, value] = match;
        if (Number(value) === BeebAsmEnd) continue;
        labels.push({ name: name.replace(/^\./, ""), address: checkedAddress(Number(value), `'${name}'`), bank: null });
    }
    const rest = body.slice(consumed).trim();
    if (rest) throw new Error(`it has ${quoted(rest)} where a label goes`);
    return labels;
}

/** @returns {Label | null} null for a disc drive's label */
function lineLabel(line, number) {
    const where = `line ${number}`;
    const vice = ViceLine.exec(line);
    if (vice) {
        const [, space, hex, name] = vice;
        if (space && space.toUpperCase() !== ViceComputerSpace) return null;
        return { name, address: checkedAddress(parseInt(hex, 16), where), bank: null };
    }
    const assignment = AssignmentLine.exec(line);
    const value = assignment && BemValue.exec(assignment[2]);
    if (!value) throw new Error(`${where}, ${quoted(line)}, isn't a BeebAsm, VICE or b-em label`);
    const [, prefixed, bank, bare] = value;
    return {
        name: assignment[1],
        address: checkedAddress(parseInt(prefixed ?? bare, 16), where),
        bank: bank === undefined ? null : parseInt(bank, 16),
    };
}

/**
 * The labels in a BeebAsm, VICE or b-em label file's text, in the file's order. Throws, saying where, on
 * anything else.
 * @returns {Label[]}
 */
export function parseLabels(text) {
    const trimmed = text.trim();
    const beebAsm = BeebAsmFile.exec(trimmed);
    const labels = beebAsm
        ? beebAsmLabels(beebAsm[1])
        : trimmed
              .split(/\r?\n/)
              .map((line, i) => (CommentLine.test(line) ? null : lineLabel(line.trim(), i + 1)))
              .filter((label) => label !== null);
    if (labels.length === 0) throw new Error("it has no labels");
    return labels;
}

function fileName(url) {
    const name = new URL(url, "file:///").pathname.split("/").pop() || url;
    try {
        return decodeURIComponent(name);
    } catch {
        return name;
    }
}

const inSideways = (address) => address >= SidewaysStart && address < SidewaysEnd;

/**
 * A label file as the debugger holds it. `bank` is the sideways bank its names in &8000-&BFFF are for,
 * or null for whatever is paged in; `set` is what credits it, shaped as a symbol set.
 */
class LabelFile {
    constructor(key, title, source, labels, bank) {
        this.key = key;
        this.title = title;
        this.labels = labels;
        this.bank = bank;
        /** @type {import("./symbol-names.js").SymbolSet} */
        this.set = {
            title,
            licence: "",
            source,
            places: new Map(),
            system: false,
            globals: new Map(),
            workspace: new Map(),
            regions: [],
        };
    }

    /** The bank `label` is for, or null if it names its address whatever is paged in. */
    bankOf(label) {
        return inSideways(label.address) ? (label.bank ?? this.bank) : null;
    }
}

/** The names of label files first, then those of the symbol sets, with the shape of SymbolNames. */
class LabelledNames {
    /**
     * @param {Map<number, import("./symbol-names.js").Named>} byAddress
     * @param {Map<string, number>} byName
     * @param {import("./symbol-names.js").SymbolSet[]} sets
     * @param {import("./symbol-names.js").SymbolNames} names
     */
    constructor(byAddress, byName, sets, names) {
        this._byAddress = byAddress;
        this._byName = byName;
        this._sets = sets;
        this._names = names;
    }

    get sets() {
        return [...this._sets, ...this._names.sets];
    }

    operand(at, target) {
        return this._byAddress.get(target) ?? this._names.operand(at, target);
    }

    address(address, pc) {
        return this._byAddress.get(address) ?? this._names.address(address, pc);
    }

    addressOf(name, pc) {
        return this._byName.get(name) ?? this._names.addressOf(name, pc);
    }

    regionAt(address) {
        return this._names.regionAt(address);
    }
}

/**
 * The label files loaded into this page, in the order they were added; a file added with the key of
 * one already here replaces it, keeping its place and any bank it was tied to. Where two name an
 * address, a name for the bank paged in comes first, then the earlier file's. Dispatches "change" when
 * one is added, removed or tied to another bank.
 */
export class LabelFiles extends EventTarget {
    /** @param {{load: (url: string) => Promise<Uint8Array>}} options */
    constructor({ load }) {
        super();
        this._load = load;
        /** @type {LabelFile[]} */
        this.files = [];
        this._byBank = new Map();
    }

    /**
     * Adds the labels in `text`, crediting `source` if it isn't empty. Throws, saying what is wrong, if
     * it isn't a label file.
     * @param {{key: string, title: string, source: string, text: string, bank: number | null}} file
     */
    add({ key, title, source, text, bank }) {
        let labels;
        try {
            labels = parseLabels(text);
        } catch (error) {
            throw new Error(`${title} isn't a label file jsbeeb reads: ${error.message}`, { cause: error });
        }
        const replaced = this.files.findIndex((each) => each.key === key);
        const file = new LabelFile(key, title, source, labels, bank ?? this.files[replaced]?.bank ?? null);
        if (replaced >= 0) this.files[replaced] = file;
        else this.files.push(file);
        this._changed();
        return file;
    }

    /** Fetches `url` and adds it, titled by the last part of its path. */
    async load(url, bank) {
        let data;
        try {
            data = await this._load(url);
        } catch (error) {
            throw new Error(`Couldn't fetch the labels in ${url}: ${error.message}`, { cause: error });
        }
        const text = new TextDecoder().decode(data);
        return this.add({ key: url, title: fileName(url), source: isHttps(url) ? url : "", text, bank });
    }

    remove(file) {
        this.files = this.files.filter((each) => each !== file);
        this._changed();
    }

    /** Ties `file`'s names in &8000-&BFFF to `bank`, or with null, to whatever is paged in. */
    tie(file, bank) {
        file.bank = bank;
        this._changed();
    }

    _changed() {
        this._byBank.clear();
        this.dispatchEvent(new Event("change"));
    }

    /**
     * The names for memory with `pagedBank` paged in: the files', ahead of `names`, the symbol sets'.
     * @param {import("./symbol-names.js").SymbolNames} names
     * @param {number} pagedBank
     */
    names(names, pagedBank) {
        if (this.files.length === 0) return names;
        if (!this._byBank.has(pagedBank)) this._byBank.set(pagedBank, this._namesFor(pagedBank));
        const { byAddress, byName, sets } = this._byBank.get(pagedBank);
        return new LabelledNames(byAddress, byName, sets, names);
    }

    _namesFor(pagedBank) {
        const byAddress = new Map();
        const byName = new Map();
        const forPagedBank = (file, label) => file.bankOf(label) === pagedBank;
        const forAnyBank = (file, label) => file.bankOf(label) === null;
        for (const applies of [forPagedBank, forAnyBank]) {
            for (const file of this.files) {
                for (const label of file.labels) {
                    if (!applies(file, label)) continue;
                    if (!byAddress.has(label.address))
                        byAddress.set(label.address, { name: label.name, set: file.set });
                    if (!byName.has(label.name)) byName.set(label.name, label.address);
                }
            }
        }
        return { byAddress, byName, sets: this.files.map((file) => file.set) };
    }
}
