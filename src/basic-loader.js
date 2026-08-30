"use strict";

/**
 * Pokes a tokenised BASIC program into memory at PAGE, and sets TOP and
 * VARTOP after it, exactly as if it had just been typed.
 */
export function installBasic(tokenised, { readByte, writeByte }) {
    const page = readByte(0x18) << 8;
    for (let i = 0; i < tokenised.length; ++i) {
        writeByte(page + i, tokenised.charCodeAt(i));
    }
    // Set VARTOP (0x12/3) and TOP(0x02/3)
    const end = page + tokenised.length;
    const endLow = end & 0xff;
    const endHigh = (end >>> 8) & 0xff;
    writeByte(0x02, endLow);
    writeByte(0x03, endHigh);
    writeByte(0x12, endLow);
    writeByte(0x13, endHigh);
}
