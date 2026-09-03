export function parseAddr(s) {
    if (s[0] === "$" || s[0] === "&") return parseInt(s.substring(1), 16);
    if (s.indexOf("0x") === 0) return parseInt(s.substring(2), 16);
    return parseInt(s, 16);
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
