// Reads what is on a headless machine's screen from the memory the CRTC is
// displaying: teletext as characters, and the bitmap modes by matching each
// 8x8 cell against the MOS font, so text a program drew itself in that font
// is read even though it never went through the VDU drivers.

const FirstFontChar = 0x20;
const FontChars = 96;
const OsModeAddress = 0x355;
const TeletextGraphicsOn = 0x11;
const TeletextGraphicsOff = 0x01;
const MaxRows = 40;
const MaxColumns = 100;

let fontLookup = null;

function fontFrom(osRom) {
    if (fontLookup) return fontLookup;
    fontLookup = new Map();
    for (let c = 0; c < FontChars; ++c) {
        const glyph = osRom.subarray(c * 8, c * 8 + 8);
        const key = Buffer.from(glyph).toString("hex");
        const inverse = Buffer.from(glyph.map((b) => b ^ 0xff)).toString("hex");
        if (c !== 0) fontLookup.set(key, String.fromCharCode(FirstFontChar + c));
        if (!fontLookup.has(inverse)) fontLookup.set(inverse, String.fromCharCode(FirstFontChar + c));
    }
    fontLookup.set("0000000000000000", " ");
    return fontLookup;
}

function teletextText(read, start, columns, rows, isMaster) {
    const lines = [];
    for (let row = 0; row < rows; ++row) {
        let graphics = false;
        let line = "";
        for (let col = 0; col < columns; ++col) {
            const ma = start + row * columns + col;
            const address = (ma & 0x3ff) | (ma & 0x800 || isMaster ? 0x7c00 : 0x3c00);
            const code = read(address) & 0x7f;
            if (code < 0x20) {
                if (code >= TeletextGraphicsOn && code < TeletextGraphicsOn + 7) graphics = true;
                if (code >= TeletextGraphicsOff && code < TeletextGraphicsOff + 7) graphics = false;
                line += " ";
            } else if (graphics && !(code >= 0x40 && code < 0x60)) {
                line += " ";
            } else {
                line += code === 0x7f ? " " : String.fromCharCode(code);
            }
        }
        lines.push(line);
    }
    return lines;
}

// Pixels per byte, from the ULA's character-rate bits and clock-rate bit.
function pixelsPerByte(ulaControl) {
    const perByteAtFastClock = [1, 2, 4, 8][(ulaControl >> 2) & 3];
    return ulaControl & 0x10 ? perByteAtFastClock : perByteAtFastClock * 2;
}

// The ink bits of one byte, as `pixels` bits with the leftmost pixel in the top bit.
function inkBits(byte, pixels) {
    if (pixels === 8) return byte;
    let bits = 0;
    const planes = 8 / pixels;
    for (let pixel = 0; pixel < pixels; ++pixel) {
        let colour = 0;
        for (let plane = 0; plane < planes; ++plane) colour |= (byte >> (7 - pixel - plane * pixels)) & 1;
        bits = (bits << 1) | colour;
    }
    return bits;
}

function bitmapText(read, start, columns, rows, ulaControl, screenSubtract, font) {
    const pixels = pixelsPerByte(ulaControl);
    if (pixels > 8 || 8 % pixels !== 0) return [];
    const bytesPerChar = 8 / pixels;
    const lines = [];
    for (let row = 0; row < rows; ++row) {
        let line = "";
        for (let col = 0; col + bytesPerChar <= columns; col += bytesPerChar) {
            const glyph = [];
            for (let scanline = 0; scanline < 8; ++scanline) {
                let bits = 0;
                for (let b = 0; b < bytesPerChar; ++b) {
                    const ma = (start + row * columns + col + b) & 0x3fff;
                    let high = (ma >> 8) & 0x0f;
                    if (ma & 0x1000) high = (high - screenSubtract) & 0x0f;
                    const address = ((high << 11) | ((ma & 0xff) << 3) | scanline) & 0x7fff;
                    bits = (bits << pixels) | inkBits(read(address), pixels);
                }
                glyph.push(bits);
            }
            line += font.get(Buffer.from(glyph).toString("hex")) ?? "·";
        }
        lines.push(line);
    }
    return lines;
}

// A share of lit pixels and a count of distinct colours, sampling every fourth pixel
// of the last complete frame.
function frameStats(session) {
    const fb = session._completeFb8;
    const colours = new Set();
    let lit = 0;
    let total = 0;
    for (let i = 0; i < fb.length; i += 16) {
        const rgb = (fb[i] << 16) | (fb[i + 1] << 8) | fb[i + 2];
        if (colours.size < 64) colours.add(rgb);
        if (rgb) lit++;
        total++;
    }
    return { lit: +(lit / total).toFixed(3), colours: colours.size };
}

export function screenState(session, osRom) {
    const cpu = session._machine.processor;
    const video = session._video;
    const regs = video.regs;
    const columns = Math.min(regs[1], MaxColumns);
    const rows = Math.min(regs[6], MaxRows);
    const start = ((regs[12] << 8) | regs[13]) & 0x3fff;
    const read = (address) => cpu.videoRead(address);
    const teletext = video.teletextMode;
    const lines = teletext
        ? teletextText(read, start, columns, rows, cpu.model.isMaster)
        : bitmapText(read, start, columns, rows, video.ulactrl, video.screenSubtract, fontFrom(osRom));
    const screenText = lines
        .map((line) => line.replace(/·+/g, (run) => (run.length > 2 ? " " : run)).trimEnd())
        .join("\n")
        .replace(/\n+$/, "");
    return {
        osMode: cpu.readmem(OsModeAddress),
        teletext,
        ulaControl: video.ulactrl,
        crtc: { r1: regs[1], r6: regs[6], r9: regs[9] },
        ...frameStats(session),
        screenText: screenText.slice(0, 2000),
    };
}
