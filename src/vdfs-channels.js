// The files the BBC has open: where each one's next byte goes, and whether what has been written has reached the
// volume's store.

import { Errors } from "./vdfs-errors.js";

export const FirstHandle = 0x11;
export const LastHandle = 0x18;
const MaxFileBytes = 0x1000000;

export class Channel {
    constructor(entry, { writable, dirty = false }) {
        this.entry = entry;
        this.writable = writable;
        this.pointer = 0;
        this.dirty = dirty;
    }

    get length() {
        return this.entry.length;
    }

    get atEnd() {
        return this.pointer >= this.length;
    }

    /** @returns {number | undefined} the next byte, or nothing at the end of the file; reading past it is an error */
    readByte() {
        if (this.pointer > this.length) throw Errors.eof();
        return this.pointer === this.length ? undefined : this.entry.buffer[this.pointer++];
    }

    /** @returns {Uint8Array} the next `count` bytes, or as many as the file has, which are not read until the pointer moves */
    peek(count) {
        const available = Math.max(0, Math.min(count, this.length - this.pointer));
        return this.entry.buffer.slice(this.pointer, this.pointer + available);
    }

    writeByte(byte) {
        this.write(Uint8Array.of(byte));
    }

    write(bytes) {
        this._requireWritable();
        const end = this.pointer + bytes.length;
        if (end > this.length) this._lengthen(end);
        this.entry.buffer.set(bytes, this.pointer);
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

    _lengthen(length) {
        if (length > MaxFileBytes) throw Errors.fileTooBig();
        this.entry.resize(length);
    }
}

export class ChannelTable {
    /** @param {import("./vdfs-volume.js").VdfsVolume} volume */
    constructor(volume) {
        this.volume = volume;
        this._channels = new Array(LastHandle - FirstHandle + 1).fill(null);
    }

    /** @returns {number} the handle of the file, newly opened */
    open(entry, { writable, dirty }) {
        const slot = this._channels.indexOf(null);
        if (slot < 0) throw Errors.tooManyOpen();
        this._channels[slot] = new Channel(entry, { writable, dirty });
        return FirstHandle + slot;
    }

    get(handle) {
        const channel = this._channels[handle - FirstHandle];
        if (!channel) throw Errors.notOpen();
        return channel;
    }

    close(handle) {
        const channel = this.get(handle);
        this._channels[handle - FirstHandle] = null;
        this.flushChannel(channel);
    }

    flushChannel(channel) {
        if (!channel.dirty) return;
        channel.dirty = false;
        this.volume.persist(channel.entry);
    }

    /** Hands what open files have had written to them to the store, leaving them open. */
    flush() {
        for (const channel of this._channels) if (channel) this.flushChannel(channel);
    }

    closeAll() {
        this.flush();
        this._channels.fill(null);
    }
}
