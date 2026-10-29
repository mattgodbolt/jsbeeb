const AddressMask = 0xffff;

const flag = (bit) => (cpu) => (cpu.p.asByte() & bit ? 1 : 0);
const truth = (test) => (test ? 1 : 0);

const Variables = new Map([
    ["A", (cpu) => cpu.a],
    ["X", (cpu) => cpu.x],
    ["Y", (cpu) => cpu.y],
    ["S", (cpu) => cpu.s],
    ["PC", (cpu) => cpu.pc],
    ["P", (cpu) => cpu.p.asByte()],
    ["C", flag(0x01)],
    ["Z", flag(0x02)],
    ["I", flag(0x04)],
    ["D", flag(0x08)],
    ["V", flag(0x40)],
    ["N", flag(0x80)],
    ["VALUE", (cpu, value) => value],
    ["OLD", (cpu, value, old) => old],
]);

// Loosest first. BBC BASIC's AND, OR and EOR are bitwise, as there; && and || are C's logical ones.
const BinaryLevels = [
    new Map([["||", (a, b) => truth(a || b)]]),
    new Map([["&&", (a, b) => truth(a && b)]]),
    new Map([
        ["|", (a, b) => a | b],
        ["OR", (a, b) => a | b],
    ]),
    new Map([
        ["^", (a, b) => a ^ b],
        ["EOR", (a, b) => a ^ b],
    ]),
    new Map([
        ["&", (a, b) => a & b],
        ["AND", (a, b) => a & b],
    ]),
    new Map([
        ["==", (a, b) => truth(a === b)],
        ["=", (a, b) => truth(a === b)],
        ["!=", (a, b) => truth(a !== b)],
        ["<>", (a, b) => truth(a !== b)],
    ]),
    new Map([
        ["<", (a, b) => truth(a < b)],
        ["<=", (a, b) => truth(a <= b)],
        [">", (a, b) => truth(a > b)],
        [">=", (a, b) => truth(a >= b)],
    ]),
    new Map([
        ["+", (a, b) => a + b],
        ["-", (a, b) => a - b],
    ]),
];

const Symbols = ["==", "!=", "<>", "<=", ">=", "&&", "||", "<", ">", "=", "&", "|", "^", "!", "?", "+", "-", "(", ")"];
const HexNumber = /^(?:&|\$|0x)([0-9a-f]+)/i;
const DecimalNumber = /^[0-9]+/;
const Word = /^[a-z_][a-z0-9_]*/i;

/**
 * Compiles a breakpoint condition to a function of the CPU, the byte read or written (the opcode, for an
 * instruction) and the byte there before a write (the byte read, for a read), which is non-zero when the condition
 * holds. Throws, naming the column, if `text` is not one.
 * @param {string} text
 * @returns {(cpu: object, value: number, old: number) => number}
 */
export function compileCondition(text) {
    let at = 0;
    let token = null;
    let tokenAt = 0;

    const fail = (what) => {
        throw new Error(`Bad condition "${text}": ${what} at column ${tokenAt + 1}`);
    };

    // A & where a value is due starts an &-prefixed hex number; after a value it is the operator.
    const advance = (valueDue) => {
        while (at < text.length && /\s/.test(text[at])) at++;
        tokenAt = at;
        const rest = text.slice(at);
        if (!rest) {
            token = null;
            return;
        }
        const hex = HexNumber.exec(rest);
        const decimal = DecimalNumber.exec(rest);
        const word = Word.exec(rest);
        if (hex && (valueDue || rest[0] !== "&")) {
            token = { number: parseInt(hex[1], 16) };
            at += hex[0].length;
        } else if (decimal) {
            token = { number: parseInt(decimal[0], 10) };
            at += decimal[0].length;
        } else if (word) {
            token = { word: word[0].toUpperCase() };
            at += word[0].length;
        } else {
            const symbol = Symbols.find((s) => rest.startsWith(s));
            if (!symbol) fail(`unexpected "${rest[0]}"`);
            token = { symbol };
            at += symbol.length;
        }
    };

    const operatorName = () => token?.symbol ?? token?.word;

    const value = () => {
        if (!token) fail("expected a value");
        const { number, word, symbol } = token;
        if (number !== undefined) {
            advance(false);
            return () => number;
        }
        if (word === "NOT" || symbol === "!") {
            advance(true);
            const operand = value();
            return (...args) => truth(!operand(...args));
        }
        if (symbol === "-") {
            advance(true);
            const operand = value();
            return (...args) => -operand(...args);
        }
        if (symbol === "?") {
            advance(true);
            const address = value();
            return (cpu, ...rest) => cpu.peekmem(address(cpu, ...rest) & AddressMask);
        }
        if (symbol === "(") {
            advance(true);
            const inner = binary(0);
            if (token?.symbol !== ")") fail('expected ")"');
            advance(false);
            return inner;
        }
        const variable = Variables.get(word);
        if (!variable) fail(word ? `unknown name "${word}"` : `unexpected "${symbol}"`);
        advance(false);
        return variable;
    };

    const binary = (level) => {
        if (level === BinaryLevels.length) return value();
        let left = binary(level + 1);
        for (;;) {
            const apply = BinaryLevels[level].get(operatorName());
            if (!apply) return left;
            advance(true);
            const lhs = left;
            const rhs = binary(level + 1);
            left = (...args) => apply(lhs(...args), rhs(...args));
        }
    };

    advance(true);
    const condition = binary(0);
    if (token) fail(`unexpected "${operatorName() ?? token.number}"`);
    return condition;
}
