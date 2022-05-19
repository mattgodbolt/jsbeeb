"use strict";

export class BitStream {
    constructor(data, numBits) {
        if (numBits === undefined) numBits = 8 * data.length;
        if (numBits <= 0) {
            // no data is an endless stream of zeros
            data = [0];
            numBits = 1;
        }
        this._numBits = numBits;
        this._bytes = new Uint8Array(data);
        this._index = 0;
    }

    position() {
        return this._index;
    }

    nextBit() {
        const byteIndex = this._index >>> 3;
        const bitIndex = this._index & 7;
        const result = ((this._bytes[byteIndex] >>> bitIndex) & 1) === 1;
        if (++this._index === this._numBits) this._index = 0;
        return result;
    }

    nextBits(numBits) {
        let result = 0;
        for (let i = 0; i < numBits; ++i) {
            result <<= 1;
            if (this.nextBit()) result |= 1;
        }
        return result;
    }

    peekBits(numBits) {
        const savedIndex = this._index;
        const result = this.nextBits(numBits);
        this._index = savedIndex;
        return result;
    }
}
