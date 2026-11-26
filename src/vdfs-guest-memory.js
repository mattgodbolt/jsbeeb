// The 6502's memory as the host reads and writes it: what a file load or save may touch, and the strings the OS
// leaves there.

import { Errors } from "./vdfs-errors.js";

export const CarriageReturn = 0x0d;
const Space = 0x20;
const Quote = 0x22;
const MemoryBytes = 0x10000;
const FirstDeviceAddress = 0xfc00;
const EndOfDevices = 0xff00;
const IoProcessor = 0xffff;
const MaxStringLength = 255;
const BytesInLong = 4;

export class GuestMemory {
    /** @param {import("./6502.js").Cpu6502} cpu */
    constructor(cpu) {
        this.cpu = cpu;
    }

    byte(address) {
        return this.cpu.peekmem(address & 0xffff);
    }

    word(address) {
        return this.byte(address) | (this.byte(address + 1) << 8);
    }

    long(address) {
        return (this.word(address) | (this.word(address + 2) << 16)) >>> 0;
    }

    setLong(address, value) {
        for (let index = 0; index < BytesInLong; index++)
            this.cpu.writemem((address + index) & 0xffff, (value >>> (8 * index)) & 0xff);
    }

    /** The text from `address` to the first byte `isEnd` says ends it. */
    text(address, isEnd = (byte) => byte === CarriageReturn) {
        let text = "";
        for (let index = 0; index < MaxStringLength; index++) {
            const byte = this.byte(address + index);
            if (isEnd(byte)) break;
            text += String.fromCharCode(byte);
        }
        return text;
    }

    /** A name ends at a space or a return, since the OS leaves the rest of a `*SAVE` or `*LOAD` line after it. */
    filename(address) {
        if (this.byte(address) !== Quote)
            return this.text(address, (byte) => byte === CarriageReturn || byte === Space);
        return this.text(address + 1, (byte) => byte === CarriageReturn || byte === Quote);
    }

    /** Where in memory `length` bytes at a 32-bit `address` are, which has to be memory the 6502 has to give or take. */
    _range(address, length, { writing }) {
        if (this.cpu.hasTube && address >>> 16 !== IoProcessor) throw Errors.unsupported("Tube transfer");
        const from = address & 0xffff;
        if (length > MemoryBytes || from + length > MemoryBytes) throw Errors.badAddress();
        if (writing && length > 0 && from < EndOfDevices && from + length > FirstDeviceAddress)
            throw Errors.badAddress();
        return from;
    }

    /** The address in the machine that a 32-bit address names, which is an error if it is in the second processor. */
    address(address) {
        return this._range(address, 0, { writing: false });
    }

    read(address, length) {
        const from = this._range(address, length, { writing: false });
        const bytes = new Uint8Array(length);
        for (let index = 0; index < length; index++) bytes[index] = this.byte(from + index);
        return bytes;
    }

    write(address, bytes) {
        const from = this._range(address, bytes.length, { writing: true });
        for (let index = 0; index < bytes.length; index++) this.cpu.writemem(from + index, bytes[index]);
    }
}
