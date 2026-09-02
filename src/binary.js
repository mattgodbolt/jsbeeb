export function signExtend(val) {
    return val >= 128 ? val - 256 : val;
}

export function uint8ArrayToString(array) {
    let str = "";
    for (let i = 0; i < array.length; ++i) str += String.fromCharCode(array[i]);
    return str;
}

export function stringToUint8Array(str) {
    if (str instanceof Uint8Array) return str;
    const len = str.length;
    const array = new Uint8Array(len);
    for (let i = 0; i < len; ++i) array[i] = str.charCodeAt(i) & 0xff;
    return array;
}

export function readInt32(data, offset) {
    return (data[offset + 3] << 24) | (data[offset + 2] << 16) | (data[offset + 1] << 8) | data[offset + 0];
}

export function readInt16(data, offset) {
    return (data[offset + 1] << 8) | data[offset + 0];
}

const tempBuf = new ArrayBuffer(4);
const tempBuf8 = new Uint8Array(tempBuf);
const tempBufF32 = new Float32Array(tempBuf);

export function readFloat32(data, offset) {
    tempBuf8[0] = data[offset];
    tempBuf8[1] = data[offset + 1];
    tempBuf8[2] = data[offset + 2];
    tempBuf8[3] = data[offset + 3];
    return tempBufF32[0];
}

export class DataStream {
    constructor(name, data) {
        this.name = name;
        this.pos = 0;
        this.data = stringToUint8Array(data);
        if (!this.data) {
            throw new Error("No data in " + name);
        }
        this.end = this.data.length;
    }

    bytesLeft() {
        return this.end - this.pos;
    }

    eof() {
        return this.bytesLeft() === 0;
    }

    advance(distance) {
        if (this.bytesLeft() < distance) throw new RangeError("EOF in " + this.name);
        this.pos += distance;
        return this.pos - distance;
    }

    readFloat32(pos) {
        if (pos === undefined) pos = this.advance(4);
        return readFloat32(this.data, pos);
    }

    readInt32(pos) {
        if (pos === undefined) pos = this.advance(4);
        return readInt32(this.data, pos);
    }

    readInt16(pos) {
        if (pos === undefined) pos = this.advance(2);
        return readInt16(this.data, pos);
    }

    readByte(pos) {
        if (pos === undefined) pos = this.advance(1);
        return this.data[pos];
    }

    readNulString(pos, maxLength) {
        if (!maxLength) maxLength = 1024;
        let posToUse = pos === undefined ? this.pos : pos;
        let result = "";
        let c;
        while ((c = this.readByte(posToUse++)) !== 0 && --maxLength) {
            result += String.fromCharCode(c);
        }
        if (maxLength === 0) return "";
        if (pos === undefined) this.pos = posToUse;
        return result;
    }

    substream(posOrLength, length) {
        let pos;
        if (length === undefined) {
            length = posOrLength;
            pos = this.advance(length);
        } else {
            pos = posOrLength;
            if (pos + length >= this.end) throw new RangeError("EOF in " + this.name);
        }
        return new DataStream(this.name + ".sub", this.data.subarray(pos, pos + length));
    }

    seek(to) {
        if (to >= this.end) throw new RangeError("Seek out of range in " + this.name);
        this.pos = to;
    }
}

export function makeFast32(u32) {
    // Firefox is ~5% faster with signed 32-bit arrays. Chrome is the same speed
    // either way, so here we unconditionally wrap all u32 buffers as i32.
    // Having a function do this makes it easy to test u32 vs i32, and means we
    // keep the rest of the code using u32 (which makes more sense to me).
    return new Int32Array(u32.buffer);
}

export class Fifo {
    constructor(capacity) {
        this._buffer = new Uint8Array(capacity);
        this._size = 0;
        this._wPtr = 0;
        this._rPtr = 0;
    }

    /** @returns {number} */
    get size() {
        return this._size;
    }

    /** @returns {boolean} */
    get full() {
        return this._size === this._buffer.length;
    }

    /** @returns {boolean} */
    get empty() {
        return this._size === 0;
    }

    clear() {
        this._size = 0;
        this._wPtr = 0;
        this._rPtr = 0;
    }

    /** @type {Number} b */
    put(b) {
        if (this.full) return;
        this._buffer[this._wPtr % this._buffer.length] = b;
        this._wPtr++;
        this._size++;
    }

    /** @returns {Number} */
    get() {
        if (this.empty) return;
        const res = this._buffer[this._rPtr % this._buffer.length];
        this._rPtr++;
        this._size--;
        return res;
    }

    /** @returns {number[]} pending bytes, oldest first */
    toArray() {
        const result = [];
        for (let i = 0; i < this._size; ++i) result.push(this._buffer[(this._rPtr + i) % this._buffer.length]);
        return result;
    }
}
