import { hexbyte } from "./hex.js";

// BBC BASIC's workspace, the same in BASIC I, II and IV: https://8bs.com/basic/memory.htm
const Lomem = 0x00;
const Himem = 0x06;
const TextPointerOffset = 0x0a;
const TextPointerBase = 0x0b;
const Top = 0x12;
const PageHigh = 0x18;
const ResidentIntegers = 0x400;
const ResidentIntegerCount = 27;
const FirstVariableInitial = 0x40;
const LastVariableInitial = 0x7a;
const ProcedureChain = 0x4f6;
const FunctionChain = 0x4f8;
/** Where the OS notes the language ROM's number, in the Advanced User Guide's map of page &02. */
export const LanguageRomNumber = 0x28c;

const RomTitle = 9;
const RomBase = 0x8000;
const FirstToken = 0x80;
const LineNumberToken = 0x8d;
const Return = 0x0d;
const Quote = 0x22;
const Colon = 0x3a;
const Star = 0x2a;
const RemToken = 0xf4;
const DataToken = 0xdc;
const Space = 0x20;
const LastPrintable = 0x7e;
const EndOfProgram = 0x80;
const LineHeaderBytes = 4;
const IntegerBytes = 4;
const ExponentBias = 128;
const MantissaSign = 0x80;
const SignificantDigits = 9;
const LargestFixedExponent = 8;
const SmallestFixedExponent = -1;
/** Beyond any list of variables or lines that fits in memory, so that a corrupted link cannot loop for ever. */
const MostEntries = 0x4000;

/**
 * Every BASIC jsbeeb carries reads each statement's first non-space character with `LDA (&0B),Y`, skipping spaces with
 * `CMP #&20: BEQ`, then tells a keyword from an assignment with `CMP #&CF`, the first statement token. The search finds
 * that `CMP`, run once for every statement.
 */
const StatementDispatch = [0xb1, 0x0b, 0xc9, 0x20, 0xf0, null, 0xc9, 0xcf];
const DispatchCompareOffset = 6;
/** The keyword table starts with AND, its first token. */
const FirstKeyword = [0x41, 0x4e, 0x44, FirstToken];
const KeywordCharacters = /^[A-Z][A-Z$(]*$/;

function findBytes(rom, pattern) {
    const found = [];
    for (let at = 0; at + pattern.length <= rom.length; ++at)
        if (pattern.every((byte, i) => byte === null || rom[at + i] === byte)) found.push(at);
    return found;
}

/** Each token's keyword, from the ROM's own table of keywords, each followed by its token and a byte of flags. */
function keywordsIn(rom) {
    const keywords = new Map();
    let [at] = findBytes(rom, FirstKeyword);
    if (at === undefined) return keywords;
    for (;;) {
        let end = at;
        while (end < rom.length && rom[end] < FirstToken) ++end;
        const keyword = String.fromCharCode(...rom.subarray(at, end));
        if (end >= rom.length || !KeywordCharacters.test(keyword)) return keywords;
        if (!keywords.has(rom[end])) keywords.set(rom[end], keyword);
        at = end + 2;
    }
}

/**
 * What a language ROM shows of BASIC: where it starts each statement, and its keywords; null for a ROM that is not a
 * BASIC this can follow.
 * @param {Uint8Array} rom
 * @returns {{statementStart: number, keywords: Map<number, string>} | null}
 */
export function basicRom(rom) {
    const dispatches = findBytes(rom, StatementDispatch);
    if (dispatches.length !== 1) return null;
    return { statementStart: RomBase + dispatches[0] + DispatchCompareOffset, keywords: keywordsIn(rom) };
}

/** A sideways ROM's title, from its header. */
export function romTitle(rom) {
    const end = rom.indexOf(0, RomTitle);
    return String.fromCharCode(...rom.subarray(RomTitle, end < 0 ? RomTitle : end)).replace(/[^ -~]/g, "");
}

const word = (peek, address) => peek(address) | (peek(address + 1) << 8);
const int32 = (peek, address) => word(peek, address) | (word(peek, address + 2) << 16);

function real(peek, address) {
    const exponent = peek(address);
    if (exponent === 0) return 0;
    const top = peek(address + 1);
    const mantissa =
        ((top | MantissaSign) * 2 ** 24 + (peek(address + 2) << 16) + (peek(address + 3) << 8) + peek(address + 4)) /
        2 ** 32;
    return (top & MantissaSign ? -1 : 1) * mantissa * 2 ** (exponent - ExponentBias);
}

/** A number as PRINT shows it with the default @%: nine significant figures, beyond which, or below 0.1, in E form. */
export function formatReal(value) {
    if (value === 0) return "0";
    const sign = value < 0 ? "-" : "";
    const [mantissa, exponentText] = Math.abs(value)
        .toExponential(SignificantDigits - 1)
        .split("e");
    const exponent = Number(exponentText);
    const digits = mantissa.replace(".", "").replace(/0+$/, "");
    if (exponent > LargestFixedExponent || exponent < SmallestFixedExponent) {
        const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
        return `${sign}${digits[0]}${fraction}E${exponent}`;
    }
    if (exponent === SmallestFixedExponent) return `${sign}0.${digits}`;
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    const fraction = digits.slice(exponent + 1);
    return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function printable(peek, from, length) {
    let text = "";
    for (let i = 0; i < length; ++i) {
        const code = peek((from + i) & 0xffff);
        text += code >= Space && code <= LastPrintable ? String.fromCharCode(code) : ".";
    }
    return text;
}

function stringValue(peek, address) {
    return `"${printable(peek, word(peek, address), peek(address + 3))}"`;
}

/** An array's name with its bounds, as DIM gave them: the stored sizes are each one more. */
function arrayName(peek, name, address) {
    const dimensions = (peek(address) - 1) / 2;
    const bounds = [];
    for (let i = 0; i < dimensions; ++i) bounds.push(word(peek, address + 1 + 2 * i) - 1);
    return `${name}${bounds.join(",")})`;
}

/**
 * The entries of one of BASIC's chains: a link to the next, then the rest of the name, ended by a zero. BASIC ends a
 * chain with a link whose high byte is zero, and leaves the low byte as it was.
 */
function* chain(peek, head) {
    let entry = word(peek, head);
    for (let count = 0; entry >> 8 !== 0 && count < MostEntries; ++count) {
        let name = "";
        let at = entry + 2;
        for (let code = peek(at); code !== 0 && name.length < MostEntries; code = peek(++at))
            name += String.fromCharCode(code);
        yield { name, value: (at + 1) & 0xffff };
        entry = word(peek, entry);
    }
}

function variable(peek, name, address) {
    if (name.endsWith("(")) return { name: arrayName(peek, name, address), value: "" };
    if (name.endsWith("%")) return { name, value: String(int32(peek, address)) };
    if (name.endsWith("$")) return { name, value: stringValue(peek, address) };
    return { name, value: formatReal(real(peek, address)) };
}

/**
 * BASIC's variables, from its workspace: its dynamic variables in order of name, and its procedures and functions.
 * @param {(address: number) => number} peek
 */
export function readVariables(peek) {
    const variables = [];
    for (let initial = FirstVariableInitial; initial <= LastVariableInitial; ++initial) {
        const first = String.fromCharCode(initial);
        for (const { name, value } of chain(peek, ResidentIntegers + 2 * initial))
            variables.push(variable(peek, first + name, value));
    }
    variables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const named = (prefix, head) => [...chain(peek, head)].map(({ name }) => prefix + name);
    return { variables, routines: [...named("PROC", ProcedureChain), ...named("FN", FunctionChain)] };
}

/**
 * The resident integers, @% (the print format, in hex) and A% to Z%.
 * @returns {{name: string, value: string}[]}
 */
export function readResidentIntegers(peek) {
    return Array.from({ length: ResidentIntegerCount }, (_, i) => {
        const value = int32(peek, ResidentIntegers + IntegerBytes * i);
        const name = `${String.fromCharCode(FirstVariableInitial + i)}%`;
        return i === 0
            ? {
                  name,
                  value: `&${(value >>> 0)
                      .toString(16)
                      .toUpperCase()
                      .padStart(2 * IntegerBytes, "0")}`,
              }
            : { name, value: String(value) };
    });
}

/** Where BASIC's program and variables are, and the address it is reading the program at. */
export function readPointers(peek) {
    return {
        page: peek(PageHigh) << 8,
        top: word(peek, Top),
        lomem: word(peek, Lomem),
        himem: word(peek, Himem),
        /** The character last read: in a statement, the statement's, and at the start of one, its first. */
        reading: (word(peek, TextPointerBase) + peek(TextPointerOffset) - 1) & 0xffff,
    };
}

/**
 * @typedef {object} ProgramLine
 * @property {number} number
 * @property {number} start the address of the return before it
 * @property {number} end the address of the return after it
 */

/**
 * The program's lines from PAGE: each a return, the line number high byte first, its length counting those four bytes,
 * then its text.
 * @returns {Generator<ProgramLine>}
 */
export function* programLines(peek, page) {
    let start = page;
    if (peek(start) !== Return) return;
    for (let count = 0; count < MostEntries; ++count) {
        const high = peek(start + 1);
        const length = peek(start + 3);
        if (high & EndOfProgram || length < LineHeaderBytes || start + length > 0xffff) return;
        const end = start + length;
        yield { number: (high << 8) | peek(start + 2), start, end };
        start = end;
    }
}

/**
 * Whether BASIC, starting a statement at `address`, has one there: it starts one at the colon that ends the statement a
 * procedure or function is called into, as at the end of its DEF, and finds it empty.
 */
export const startsStatement = (peek, address) => peek(address) !== Colon;

/** Whether `address` is in `line`'s text or the return that ends it. */
export const holds = (line, address) => address > line.start && address <= line.end;

/** The line holding `address`, or null when it is outside the program, as it is in a command typed at the prompt. */
export function lineHolding(peek, page, address) {
    for (const line of programLines(peek, page)) if (holds(line, address)) return line;
    return null;
}

export function findLine(peek, page, number) {
    for (const line of programLines(peek, page)) if (line.number === number) return line;
    return null;
}

/** The address of a line's first statement, after any spaces. */
export function firstStatement(peek, line) {
    let at = line.start + LineHeaderBytes;
    while (at < line.end && peek(at) === Space) ++at;
    return at;
}

/** The line number following the line number token, its bits rearranged so that no byte of it is a return. */
function lineNumberAfterToken(peek, at) {
    const mixed = peek(at);
    const low = peek(at + 1) ^ ((mixed << 2) & 0xc0);
    const high = peek(at + 2) ^ ((mixed << 4) & 0xc0);
    return (high << 8) | low;
}

/**
 * A line listed as LIST shows it, in statements, each with the addresses it spans up to the colon or return ending it.
 * REM, DATA and a star command take the rest of the line, colons and all.
 * @param {(address: number) => number} peek
 * @param {ProgramLine} line
 * @param {Map<number, string>} keywords
 * @returns {{text: string, from: number, to: number}[]}
 */
export function listStatements(peek, line, keywords) {
    const statements = [];
    let text = "";
    let from = line.start + LineHeaderBytes;
    let quoted = false;
    let restOfLine = false;
    for (let at = from; at < line.end; ++at) {
        const code = peek(at);
        if (!quoted && (code === RemToken || code === DataToken || (code === Star && text.trim() === "")))
            restOfLine = true;
        if (code === Colon && !quoted && !restOfLine) {
            statements.push({ text, from, to: at });
            text = "";
            from = at + 1;
        } else if (quoted || code < FirstToken) {
            if (code === Quote) quoted = !quoted;
            text += code >= Space && code <= LastPrintable ? String.fromCharCode(code) : ".";
        } else if (code === LineNumberToken) {
            text += lineNumberAfterToken(peek, at + 1);
            at += 3;
        } else {
            text += keywords.get(code) ?? `[&${hexbyte(code)}]`;
        }
    }
    statements.push({ text, from, to: line.end });
    return statements;
}
