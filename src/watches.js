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

const Comparisons = {
    "=": (a, b) => a === b,
    "!=": (a, b) => a !== b,
    "<": (a, b) => a < b,
    "<=": (a, b) => a <= b,
    ">": (a, b) => a > b,
    ">=": (a, b) => a >= b,
};
const ConditionPattern = /^(!=|<=|>=|=|<|>)\s*(?:(?:\$|&|0x)([0-9a-f]+)|([0-9]+))$/i;

/**
 * @typedef {object} WatchCondition
 * @property {string} text
 * @property {(value: number) => boolean} holds
 */

/**
 * A break's condition, such as `= 5`, `!= $20` or `> &7f`: decimal unless marked hex by `$`, `&` or `0x`.
 * @param {string} text
 * @returns {WatchCondition | undefined}
 */
export function parseCondition(text) {
    const match = ConditionPattern.exec(text.trim());
    if (!match) return undefined;
    const [, op, hex, dec] = match;
    const operand = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    const compare = Comparisons[op];
    return {
        text: `${op}${hex === undefined ? dec : `$${hex.toLowerCase()}`}`,
        holds: (value) => compare(value, operand),
    };
}

/**
 * Whether the CPU writing `byte` to `address` stops a break on `watch`: a write that changes its value, to one its
 * condition holds for if it has one. A write to a byte that is not RAM stops it whatever it changes, testing the
 * condition against the byte written, as a device register reads back the device's state rather than the write.
 * @param {(address: number) => number} peek
 * @param {{address: number, format: WatchFormat, condition: WatchCondition | null}} watch
 * @param {number} address
 * @param {number} byte
 * @param {boolean} toRam
 */
export function writeStops(peek, watch, address, byte, toRam) {
    const { format, condition } = watch;
    if (((address - watch.address) & 0xffff) >= format.bytes) return false;
    if (!toRam) return !condition || condition.holds(byte);
    const after = watchValue((at) => (at === address ? byte : peek(at)), watch.address, format);
    if (after === watchValue(peek, watch.address, format)) return false;
    return !condition || condition.holds(after);
}
