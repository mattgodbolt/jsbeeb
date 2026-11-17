import { hexbyte } from "./hex.js";
import { tightLoopAt } from "./tight-loop.js";

// BBC BASIC's workspace, the same in BASIC I, II and IV: https://8bs.com/basic/memory.htm
const Lomem = 0x00;
const VariablesEnd = 0x02;
const Himem = 0x06;
const ErrorLine = 0x08;
export const TextPointerOffset = 0x0a;
export const TextPointerBase = 0x0b;
const Top = 0x12;
const PageHigh = 0x18;
const ExpressionPointerBase = 0x19;
const ExpressionPointerOffset = 0x1b;
const ResidentIntegers = 0x400;
const ResidentIntegerCount = 27;
const FirstVariableInitial = 0x40;
const LastVariableInitial = 0x7a;
const ProcedureChain = 0x4f6;
const FunctionChain = 0x4f8;
/** Where the OS notes the language ROM's number, in the Advanced User Guide's map of page &02. */
export const LanguageRomNumber = 0x28c;
/** Where the OS's BRK handler leaves the address of the error block, its number then its message, low byte first. */
export const ErrorBlockPointer = 0xfd;
/** RDCHV, the vector the OS reads a character through, in the same map. */
const ReadCharacterVector = 0x210;
/**
 * Far enough into the OS's read-character routine to take in its wait for a key, whose call into the keyboard buffer
 * returns to &DEEF in OS 1.20 (the routine is at &DEC5) and to &E7E3 in MOS 3.20 (at &E7BC).
 */
const ReadCharacterBytes = 0x40;
/**
 * FILEV, which a filing system ROM extends: it then holds the OS's entry for an extended FILEV, and the OS's table of
 * extended vectors holds the ROM's number.
 */
const FileVector = 0x212;
const Vectors = 0x200;
const ExtendedVectorEntries = 0xff00;
const ExtendedVectors = 0xd9f;
const ExtendedVectorBytes = 3;
const ExtendedVectorRom = 2;
/** The OS counts vsyncs here, and *FX19 waits for the count to change. */
const VsyncCounter = 0x240;
const StackPage = 0x100;
const StackTop = 0xff;

const RomTitle = 9;
const RomBase = 0x8000;
const RomEnd = 0xc000;
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
const MostMessageBytes = 255;
/** BASIC IV keeps "Missing " in its messages as a token of its own, which is not a keyword. */
const MissingToken = 0x8d;
/** More lines than fit in memory, so that a walk over memory that is not a program ends. */
const MostLines = 0x4000;

/**
 * Every BASIC jsbeeb carries reads each statement's first non-space character with `LDA (&0B),Y`, skipping spaces with
 * `CMP #&20: BEQ`, then tells a keyword from an assignment with `CMP #&CF`, the first statement token. The search finds
 * that `LDA` (statementRead) and that `CMP` (statementStart), which runs once for every statement.
 */
const StatementDispatch = [0xb1, 0x0b, 0xc9, 0x20, 0xf0, null, 0xc9, 0xcf];
const DispatchCompareOffset = 6;
/** The keyword table starts with AND, its first token. */
const FirstKeyword = [0x41, 0x4e, 0x44, FirstToken];
const KeywordCharacters = /^[A-Z][A-Z$(]*$/;
const KeyboardFunctions = new Set(["GET", "GET$", "INKEY", "INKEY$"]);

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
 * What a language ROM shows of BASIC: where it reads each statement's first character, where it starts each statement,
 * and its keywords; null for a ROM that is not a BASIC this can follow.
 * @param {Uint8Array} rom
 * @returns {{statementRead: number, statementStart: number, keywords: Map<number, string>} | null}
 */
export function basicRom(rom) {
    const dispatches = findBytes(rom, StatementDispatch);
    if (dispatches.length !== 1) return null;
    const statementRead = RomBase + dispatches[0];
    return { statementRead, statementStart: statementRead + DispatchCompareOffset, keywords: keywordsIn(rom) };
}

/** A sideways ROM's title, from its header. */
export function romTitle(rom) {
    const end = rom.indexOf(0, RomTitle);
    return String.fromCharCode(...rom.subarray(RomTitle, end < 0 ? RomTitle : end)).replace(/[^ -~]/g, "");
}

const word = (peek, address) => peek(address) | (peek(address + 1) << 8);
const int32 = (peek, address) => word(peek, address) | (word(peek, address + 2) << 16);
const textReading = (peek, base, offset) => (word(peek, base) + peek(offset) - 1) & 0xffff;

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
 * chain with a link whose high byte is zero, and leaves the low byte as it was. Every entry is in the heap, between
 * LOMEM and the end of the variables, and in no other chain, so a walk over memory that is not BASIC's ends there.
 * @param {(address: number) => number} peek
 * @param {number} head
 * @param {{lomem: number, end: number, seen: Set<number>}} heap
 */
function* chain(peek, head, heap) {
    let entry = word(peek, head);
    while (entry >> 8 !== 0 && entry >= heap.lomem && entry < heap.end && !heap.seen.has(entry)) {
        heap.seen.add(entry);
        let name = "";
        let at = entry + 2;
        for (let code = peek(at); code !== 0 && at < heap.end; code = peek(++at)) name += String.fromCharCode(code);
        yield { name, value: (at + 1) & 0xffff };
        entry = word(peek, entry);
    }
}

function variable(peek, name, address) {
    if (name.endsWith("(")) return { name: arrayName(peek, name, address), value: "(array)" };
    if (name.endsWith("%")) return { name, value: String(int32(peek, address)) };
    if (name.endsWith("$")) return { name, value: stringValue(peek, address) };
    return { name, value: formatReal(real(peek, address)) };
}

/**
 * BASIC's variables, from its workspace: its dynamic variables in order of name, and its procedures and functions.
 * @param {(address: number) => number} peek
 */
export function readVariables(peek) {
    const heap = { lomem: word(peek, Lomem), end: word(peek, VariablesEnd), seen: new Set() };
    const variables = [];
    for (let initial = FirstVariableInitial; initial <= LastVariableInitial; ++initial) {
        const first = String.fromCharCode(initial);
        for (const { name, value } of chain(peek, ResidentIntegers + 2 * initial, heap))
            variables.push(variable(peek, first + name, value));
    }
    variables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const named = (prefix, head) => [...chain(peek, head, heap)].map(({ name }) => prefix + name);
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
        reading: textReading(peek, TextPointerBase, TextPointerOffset),
        /** The character last read of an expression in the statement. */
        expression: textReading(peek, ExpressionPointerBase, ExpressionPointerOffset),
    };
}

function errorMessage(peek, block, keywords) {
    let message = "";
    for (let at = block + 1; at <= block + MostMessageBytes; ++at) {
        const code = peek(at & 0xffff);
        if (code === 0) break;
        if (code === MissingToken) message += "Missing ";
        else if (code >= FirstToken) message += keywords.get(code) ?? ".";
        else message += code >= Space && code <= LastPrintable ? String.fromCharCode(code) : ".";
    }
    return message;
}

/**
 * The error BASIC's own handler last reported, with its tokens spelt out as REPORT prints them, or null. That handler,
 * which reports an error no ON ERROR takes and any numbered 0 such as STOP, is BASIC text in the ROM, so this lasts
 * until BASIC next reads text through its expression pointer, as LIST does not. The line number is 0 for an error in a
 * command typed at the prompt. The caller checks that BASIC is the language running.
 * @param {(address: number) => number} peek
 * @param {Map<number, string>} keywords
 * @returns {{number: number, message: string, lineNumber: number} | null}
 */
export function readReportedError(peek, keywords) {
    const expression = word(peek, ExpressionPointerBase);
    if (expression < RomBase || expression >= RomEnd) return null;
    const block = word(peek, ErrorBlockPointer);
    return { number: peek(block), message: errorMessage(peek, block, keywords), lineNumber: word(peek, ErrorLine) };
}

/**
 * Whether the CPU is in the OS's read-character routine: at `pc`, or below a call the routine made or an interrupt
 * taken in it, either of which leaves an address in the routine on the stack.
 */
function readingCharacter(peek, pc, stackPointer) {
    const routine = word(peek, ReadCharacterVector);
    const inRoutine = (address) => address >= routine && address < routine + ReadCharacterBytes;
    if (inRoutine(pc)) return true;
    for (let at = stackPointer + 1; at < StackTop; ++at) if (inRoutine(word(peek, StackPage + at))) return true;
    return false;
}

/** The ROM number of the filing system that has extended FILEV, or null where none has. */
function filingSystemRom(peek) {
    const vector = (FileVector - Vectors) / 2;
    if (word(peek, FileVector) !== ExtendedVectorEntries + ExtendedVectorBytes * vector) return null;
    return peek(ExtendedVectors + ExtendedVectorBytes * vector + ExtendedVectorRom);
}

/**
 * Of the statement in `line` that BASIC's pointers are in, its first character after any spaces and its tokens up to
 * the later pointer, not counting those in strings. The statement pointer can be on the colon before a statement that
 * BASIC reads through the expression pointer, as it does one that does not start with a keyword, or on the colon after
 * one it has finished, with the expression pointer left behind.
 */
function statementUpTo(peek, line, { reading, expression }) {
    let first = null;
    let tokens = [];
    let quoted = false;
    for (let at = line.start + LineHeaderBytes; at <= Math.max(reading, expression) && at < line.end; ++at) {
        const code = peek(at);
        if (code === Quote) quoted = !quoted;
        if (quoted) continue;
        if (code === Colon) {
            if (at > reading || (at === reading && expression < reading)) break;
            first = null;
            tokens = [];
            continue;
        }
        if (first === null && code !== Space) first = code;
        if (code === LineNumberToken) at += 3;
        else if (code >= FirstToken) tokens.push(code);
    }
    return { first, tokens };
}

/** The keyword a statement reading a key waits in: its last GET, GET$, INKEY or INKEY$, else INPUT or INPUT LINE. */
function keyboardKeyword({ first, tokens }, keywords) {
    const spelt = tokens.map((token) => keywords.get(token));
    const reading = spelt.findLast((keyword) => KeyboardFunctions.has(keyword));
    if (reading) return reading;
    if (keywords.get(first) !== "INPUT") return null;
    return spelt[1] === "LINE" ? "INPUT LINE" : "INPUT";
}

/**
 * Where the machine is, of the places a program can wait, or null: "keyboard", in the OS's read-character routine, as
 * GET, INKEY with a time limit and INPUT are, with the keyword of those the statement BASIC is in (in `line`) waits in,
 * where it shows; "vsync", in a tight loop on the OS's count of vsyncs, as *FX19 is; "filing system", with the filing
 * system's ROM paged in; "sound", in a SOUND statement, which only takes long while its channel's queue is full. Only
 * the vsync loop is a wait in itself: a program passes through the others, as INKEY(0) does, and is waiting only if it
 * stays.
 * @param {import("./6502.js").Cpu6502} cpu
 * @param {ProgramLine | null} line
 * @param {Map<number, string>} keywords
 * @returns {{kind: "keyboard" | "vsync" | "filing system" | "sound", keyword: string | null} | null}
 */
export function readWait(cpu, line, keywords) {
    const peek = (address) => cpu.peekmemAsLanguage(address);
    const { pc } = cpu;
    const statement = line ? statementUpTo(peek, line, readPointers(peek)) : { first: null, tokens: [] };
    if (readingCharacter(peek, pc, cpu.s)) return { kind: "keyboard", keyword: keyboardKeyword(statement, keywords) };
    if (tightLoopAt(cpu.disassembler, pc)?.reads.includes(VsyncCounter)) return { kind: "vsync", keyword: null };
    const filingSystem = filingSystemRom(peek);
    if (filingSystem !== null && cpu.isBankPagedAt(cpu.bankPagedBy(filingSystem), pc))
        return { kind: "filing system", keyword: null };
    if (keywords.get(statement.first) === "SOUND") return { kind: "sound", keyword: null };
    return null;
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
    for (let count = 0; count < MostLines; ++count) {
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
