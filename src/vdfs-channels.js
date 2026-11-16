// The files the BBC has open. A file is read when it is opened and held here, as a disc filing system holds a file's
// sector, and written back when it is closed or flushed.

import { Errors } from "./vdfs-errors.js";
import { sameName } from "./vdfs-names.js";

export const FirstHandle = 0x11;
export const LastHandle = 0x18;
const MaxFileBytes = 0x1000000;

export class Channel {
    /**
     * @param {{path: string[], data: Uint8Array, info: {load: number, exec: number, locked: boolean}, writable: boolean}} file
     *   where it is, what it holds, and the addresses and lock it has
     */
    constructor({ path, data, info, writable }) {
        this.path = path;
        this.buffer = data;
        this.length = data.length;
        this.info = info;
        this.writable = writable;
        this.pointer = 0;
        /** Whether what it holds is not what is in the store. */
        this.dirty = false;
        /** Whether the file has been deleted or replaced since, so that what it holds is not the store's any more. */
        this.detached = false;
    }

    get bytes() {
        return this.buffer.subarray(0, this.length);
    }

    get atEnd() {
        return this.pointer >= this.length;
    }

    /** @returns {number | undefined} the next byte, or nothing at the end of the file; reading past it is an error */
    readByte() {
        if (this.pointer > this.length) throw Errors.eof();
        return this.pointer === this.length ? undefined : this.buffer[this.pointer++];
    }

    /** @returns {Uint8Array} the next `count` bytes, or as many as the file has, which are not read until the pointer moves */
    peek(count) {
        const available = Math.max(0, Math.min(count, this.length - this.pointer));
        return this.buffer.slice(this.pointer, this.pointer + available);
    }

    writeByte(byte) {
        this.write(Uint8Array.of(byte));
    }

    write(bytes) {
        this._requireWritable();
        const end = this.pointer + bytes.length;
        if (end > this.length) this._lengthen(end);
        this.buffer.set(bytes, this.pointer);
        this.pointer = end;
        this.dirty = true;
    }

    setLength(length) {
        this._requireWritable();
        this._lengthen(length);
        this.dirty = true;
    }

    _requireWritable() {
        if (!this.writable) throw Errors.locked();
    }

    /** Sets the length, doubling the room when there is not enough and zero-filling any growth. */
    _lengthen(length) {
        if (length > MaxFileBytes) throw Errors.fileTooBig();
        if (length > this.buffer.length) {
            const bigger = new Uint8Array(Math.max(length, this.buffer.length * 2));
            bigger.set(this.bytes);
            this.buffer = bigger;
        } else if (length < this.length) {
            this.buffer.fill(0, length, this.length);
        }
        this.length = length;
    }
}

export class ChannelTable {
    constructor() {
        this._channels = new Array(LastHandle - FirstHandle + 1).fill(null);
    }

    /** Throws if there is no handle left, which is better known before a file is made or read for it. */
    requireRoom() {
        if (!this._channels.includes(null)) throw Errors.tooManyOpen();
    }

    /** @returns {number} the handle of the file, newly opened */
    open(channel) {
        const slot = this._channels.indexOf(null);
        if (slot < 0) throw Errors.tooManyOpen();
        this._channels[slot] = channel;
        return FirstHandle + slot;
    }

    get(handle) {
        const channel = this._channels[handle - FirstHandle];
        if (!channel) throw Errors.notOpen();
        return channel;
    }

    /** Lets go of a file that has been written back, if it is still open. */
    release(channel) {
        const slot = this._channels.indexOf(channel);
        if (slot >= 0) this._channels[slot] = null;
    }

    /** Closes a file, which is the caller's to write back. */
    take(handle) {
        const channel = this.get(handle);
        this._channels[handle - FirstHandle] = null;
        return channel;
    }

    /** Closes every file, which are the caller's to write back. */
    takeAll() {
        const open = this._channels.filter(Boolean);
        this._channels.fill(null);
        return open;
    }

    /** The open files. */
    all() {
        return this._channels.filter(Boolean);
    }

    /** Says that the file at `path` is no longer what its channels hold, as when it is deleted or replaced. */
    detachPath(path) {
        for (const channel of this.all())
            if (channel.path.length === path.length && channel.path.every((name, index) => sameName(name, path[index])))
                channel.detached = true;
    }
}
