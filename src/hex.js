const HexAddress = /^(?:\$|&|0x)?([0-9a-f]{1,4})$/i;

/** @returns {number | undefined} */
export function parseAddr(s) {
    const digits = HexAddress.exec(s)?.[1];
    return digits === undefined ? undefined : parseInt(digits, 16);
}

const FirstPrintable = 0x20;
const PastPrintable = 0x80;

/** A byte as text: its character if printable, a dot if not. */
export function byteChar(byte) {
    return byte >= FirstPrintable && byte < PastPrintable ? String.fromCharCode(byte) : ".";
}

export function hexbyte(value) {
    return ((value >>> 4) & 0xf).toString(16) + (value & 0xf).toString(16);
}

export function hexword(value) {
    return hexbyte(value >>> 8) + hexbyte(value & 0xff);
}

export function hd(reader, start, end, opts) {
    opts = opts || {};
    const width = opts.width || 16;
    const gap = opts.gap === undefined ? 8 : opts.gap;
    const res = [];
    let str = "";
    let j = 0;
    for (let i = start; i < end; ++i) {
        str += " ";
        str += hexbyte(reader(i));
        if (++j === gap) str += " ";
        if (j === width) {
            res.push(str);
            str = "";
            j = 0;
        }
    }
    if (str) res.push(str);
    let joined = "";
    for (let i = 0; i < res.length; ++i) {
        joined += hexword(start + i * width) + " :" + res[i] + "\n";
    }
    return joined;
}
