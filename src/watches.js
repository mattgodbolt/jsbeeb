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
    let value = 0;
    for (let i = format.bytes - 1; i >= 0; --i) value = value * 256 + peek((address + i) & 0xffff);
    return format.radix === 16 ? `$${value.toString(16).padStart(format.bytes * 2, "0")}` : String(value);
}
