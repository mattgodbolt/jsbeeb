import { compileCondition } from "./conditions.js";

/**
 * @typedef {object} WatchFormat
 * @property {string} name
 * @property {number} bytes - read little-endian
 * @property {number} radix - 10 or 16
 * @property {string} description
 */

/** @type {WatchFormat[]} */
export const WatchFormats = [
    { name: "dec", bytes: 1, radix: 10, description: "one byte, in decimal" },
    { name: "hex", bytes: 1, radix: 16, description: "one byte, in hex" },
    { name: "dec16", bytes: 2, radix: 10, description: "two bytes, little-endian, in decimal" },
    { name: "hex16", bytes: 2, radix: 16, description: "two bytes, little-endian, in hex" },
    { name: "dec32", bytes: 4, radix: 10, description: "four bytes, little-endian, in decimal" },
    { name: "hex32", bytes: 4, radix: 16, description: "four bytes, little-endian, in hex" },
];

/**
 * `format`'s bytes from `address` up, wrapping past 0xffff, as `peek` reads them.
 * @param {(address: number) => number} peek
 * @param {number} address
 * @param {WatchFormat} format
 */
export function formatWatch(peek, address, format) {
    const value = watchValue(peek, address, format);
    return format.radix === 16 ? `$${value.toString(16).padStart(format.bytes * 2, "0")}` : String(value);
}

function watchValue(peek, address, format) {
    let value = 0;
    for (let i = format.bytes - 1; i >= 0; --i) value = value * 256 + peek((address + i) & 0xffff);
    return value;
}

const LeadingComparison = /^(==|!=|<>|<=|>=|=|<|>)?\s*/;
const NumberLiteral = /^(?:(?:\$|&|0x)([0-9a-f]+)|([0-9]+))$/i;

/**
 * @typedef {object} WatchCondition
 * @property {string} text
 * @property {(value: number, old: number, cpu: object, pc: number) => boolean} holds - whether it holds for the
 * watch's value after a write and `old` before it, made by the instruction at `pc`
 */

/**
 * A break's condition: a comparison and what the watch's value is compared with, such as `= 5`, `!= $20` or
 * `> ?&70`, in the language of src/conditions.js: everything after the comparison is what the value is compared
 * with. There `value` is the watch's value after the write and `old` its value before. A bare value, such as `5`,
 * means `= 5`, and `==` is `=`.
 * @param {string} text
 * @returns {WatchCondition | undefined}
 */
export function parseCondition(text) {
    const trimmed = text.trim();
    const [comparison, typed] = LeadingComparison.exec(trimmed);
    const op = typed === undefined || typed === "==" ? "=" : typed;
    const operand = trimmed.slice(comparison.length);
    let test;
    try {
        test = compileCondition(`value ${op} (${operand})`);
    } catch {
        return undefined;
    }
    const [, hex, dec] = NumberLiteral.exec(operand) ?? [];
    const shown = hex !== undefined ? `$${hex.toLowerCase()}` : (dec ?? operand);
    return { text: `${op}${shown}`, holds: (value, old, cpu, pc) => test(cpu, pc, value, old) !== 0 };
}

/**
 * Whether the CPU writing `byte` to `address` stops a break on `watch`: a write that changes its value, to one its
 * condition holds for if it has one. A write to a device stops it whatever it changes, testing the
 * condition against the byte written, as a device register reads back the device's state rather than the write.
 * @param {(address: number) => number} peek
 * @param {{address: number, format: WatchFormat, condition: WatchCondition | null}} watch
 * @param {number} address
 * @param {number} byte
 * @param {boolean} toRam
 * @param {object} cpu - for a condition reading registers or memory
 * @param {number} pc - the instruction writing
 */
export function writeStops(peek, watch, address, byte, toRam, cpu, pc) {
    const { format, condition } = watch;
    if (((address - watch.address) & 0xffff) >= format.bytes) return false;
    if (!toRam) return !condition || condition.holds(byte, byte, cpu, pc);
    const after = watchValue((at) => (at === address ? byte : peek(at)), watch.address, format);
    const before = watchValue(peek, watch.address, format);
    if (after === before) return false;
    return !condition || condition.holds(after, before, cpu, pc);
}
