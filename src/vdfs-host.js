// The host half of VDFS: the device the ROM in roms-src/vdfs talks to, and the filing system behind it. The ROM
// hands over a call's registers, and the host answers with a stream of ops for the ROM to carry out. See docs/vdfs.md.

import { Errors, VdfsError, wildcardMatcher } from "./vdfs-volume.js";

export const PortBase = 0xfc60;
export const PortCount = 8;
export const Port = Object.freeze({ call: 0, a: 1, x: 2, y: 3, p: 4, stream: 5, data: 6, id: 7 });
export const HostId = 0x56;
export const VdfsRom = "vdfs.rom";

export const Call = Object.freeze({ service: 0, file: 1, args: 2, bget: 3, bput: 4, gbpb: 5, find: 6, fsc: 7 });
export const Op = Object.freeze({ done: 0, print: 1, error: 2, exec: 3, claim: 4, oscli: 5 });

export const FilingSystemNumber = 0x11;
export const FirstHandle = 0x11;
export const LastHandle = 0x18;
const Title = "VDFS";
const Commands = "CAT CDIR DELETE DIR EX INFO LIB VDFS";
const Version = "0.1";

const Service = Object.freeze({ command: 0x04, help: 0x09, select: 0x12 });
const Fsc = Object.freeze({
    option: 0,
    eof: 1,
    slashRun: 2,
    unrecognised: 3,
    run: 4,
    catalogue: 5,
    newFilingSystem: 6,
    handles: 7,
    examine: 9,
    info: 10,
});

const Carry = 0x01;
const IoProcessor = 0xffff;
const CommandLinePointer = 0xf2;
const FileAttributes = 0x03;
const LockedAttribute = 0x08;
const Carriage = "\r";
const Space = 0x20;
const Quote = 0x22;
const CataloguePerLine = 3;
const CatalogueColumnWidth = 13;
const NameWidth = 10;
const ObjectNone = 0;
const ObjectFile = 1;
const ObjectDirectory = 2;

const hex = (value, digits) => value.toString(16).toUpperCase().padStart(digits, "0");

/** What the ROM is to do once a call has been made, as the bytes it reads from the stream. */
class Response {
    constructor() {
        this.bytes = [];
    }

    _text(text) {
        for (const char of text) this.bytes.push(char.charCodeAt(0) & 0x7f);
        this.bytes.push(0);
    }

    print(text) {
        this.bytes.push(Op.print);
        this._text(text);
    }

    error(number, text) {
        this.bytes.push(Op.error, number);
        this._text(text);
    }

    /** The ROM runs the program at `address` once it has returned to the OS. */
    exec(address) {
        const less = (address - 1) & 0xffff;
        this.bytes.push(Op.exec, less >> 8, less & 0xff);
    }

    claim() {
        this.bytes.push(Op.claim);
    }

    oscli(command) {
        this.bytes.push(Op.oscli);
        this._text(command);
    }

    done({ a, x, y, p }) {
        this.bytes.push(Op.done, x & 0xff, y & 0xff, p & 0xff, a & 0xff);
    }
}

/** An open file: where the next byte goes, and whether what has been written has reached the store. */
class Channel {
    constructor(entry, { writable }) {
        this.entry = entry;
        this.writable = writable;
        this.pointer = 0;
        this.dirty = false;
    }
}

export class VdfsHost {
    /**
     * @param {import("./6502.js").Cpu6502} cpu the machine whose memory the files are read to and written from
     * @param {import("./vdfs-volume.js").VdfsVolume} volume the files
     */
    constructor(cpu, volume) {
        this.cpu = cpu;
        this.volume = volume;
        this._request = { a: 0, x: 0, y: 0, p: 0 };
        this._streams = new Map();
        this._nextStream = 1;
        this._responseStream = 0;
        this._selectedStream = 0;
        this._channels = new Array(LastHandle - FirstHandle + 1).fill(null);
        this.reset();
    }

    /** A break: the OS has gone back to its own filing system, and files open on the old one are closed. */
    reset() {
        this.closeAll();
        this.selected = false;
        this._reselecting = false;
        this.directory = this.volume.root;
        this.library = this.volume.root;
        this.bootOption = 0;
    }

    read(offset) {
        switch (offset) {
            case Port.stream:
                return this._responseStream;
            case Port.data:
                return this._nextByte();
            case Port.id:
                return HostId;
            default:
                return 0;
        }
    }

    write(offset, value) {
        switch (offset) {
            case Port.call:
                this._call(value);
                break;
            case Port.a:
                this._request.a = value;
                break;
            case Port.x:
                this._request.x = value;
                break;
            case Port.y:
                this._request.y = value;
                break;
            case Port.p:
                this._request.p = value;
                break;
            case Port.stream:
                this._selectedStream = value;
                break;
        }
    }

    _nextByte() {
        const stream = this._streams.get(this._selectedStream);
        if (!stream) return 0;
        const byte = stream.bytes[stream.position++];
        if (stream.position >= stream.bytes.length) this._streams.delete(this._selectedStream);
        return byte ?? 0;
    }

    _call(call) {
        const registers = { ...this._request };
        const response = new Response();
        try {
            this._dispatch(call, registers, response);
            response.done(registers);
        } catch (error) {
            if (error instanceof VdfsError) response.error(error.number, error.message);
            else {
                console.error("VDFS host failure:", error);
                response.error(0xff, `VDFS host failure: ${error.message}`);
            }
        }
        this._responseStream = this._newStream(response.bytes);
    }

    _newStream(bytes) {
        const id = this._nextStream;
        this._nextStream = this._nextStream === 0xff ? 1 : this._nextStream + 1;
        this._streams.set(id, { bytes, position: 0 });
        return id;
    }

    _dispatch(call, registers, response) {
        switch (call) {
            case Call.service:
                return this._service(registers, response);
            case Call.file:
                return this._file(registers);
            case Call.args:
                return this._args(registers);
            case Call.bget:
                return this._bget(registers);
            case Call.bput:
                return this._bput(registers);
            case Call.gbpb:
                return this._gbpb(registers);
            case Call.find:
                return this._find(registers);
            case Call.fsc:
                return this._fsc(registers, response);
            default:
                throw new Error(`unknown call ${call}`);
        }
    }

    // ---- The 6502's memory ----

    _byte(address) {
        return this.cpu.peekmem(address & 0xffff);
    }

    _word(address) {
        return this._byte(address) | (this._byte(address + 1) << 8);
    }

    _long(address) {
        return (this._word(address) | (this._word(address + 2) << 16)) >>> 0;
    }

    _setLong(address, value) {
        for (let index = 0; index < 4; index++)
            this.cpu.writemem((address + index) & 0xffff, (value >>> (8 * index)) & 0xff);
    }

    _string(address) {
        let text = "";
        for (let index = 0; index < 255; index++) {
            const byte = this._byte(address + index);
            if (byte === 0x0d) break;
            text += String.fromCharCode(byte);
        }
        return text;
    }

    /** The address in the machine a 32-bit address names. Addresses in the second processor are not served. */
    _memoryAddress(address) {
        if (this.cpu.hasTube && address >>> 16 !== IoProcessor) throw Errors.unsupported("Tube transfer");
        return address & 0xffff;
    }

    _readMemory(address, length) {
        const from = this._memoryAddress(address);
        const bytes = new Uint8Array(length);
        for (let index = 0; index < length; index++) bytes[index] = this._byte(from + index);
        return bytes;
    }

    _writeMemory(address, bytes) {
        const from = this._memoryAddress(address);
        for (let index = 0; index < bytes.length; index++) this.cpu.writemem((from + index) & 0xffff, bytes[index]);
    }

    /** A name ends at a space or a return, since the OS leaves the rest of a `*SAVE` or `*LOAD` line after it. */
    _filename(address) {
        const quoted = this._byte(address) === Quote;
        let text = "";
        for (let index = quoted ? 1 : 0; index < 255; index++) {
            const byte = this._byte(address + index);
            if (byte === 0x0d || (quoted ? byte === Quote : byte === Space)) break;
            text += String.fromCharCode(byte);
        }
        return text;
    }

    _commandLine(offset) {
        return this._string(this._word(CommandLinePointer) + offset);
    }

    // ---- Names ----

    _resolve(text) {
        return this.volume.resolve(text, { cwd: this.directory, library: this.library });
    }

    _existing(text) {
        const { entry } = this._resolve(text);
        if (!entry) throw Errors.notFound();
        return entry;
    }

    // ---- Service calls ----

    _service(registers, response) {
        switch (registers.a) {
            case Service.command: {
                const { name, argument } = this._parseCommand(this._commandLine(registers.y));
                if (name === "VDFS") {
                    this._select(response);
                    registers.a = 0;
                } else if (this.selected && this._runCommand(name, argument, response)) {
                    registers.a = 0;
                }
                break;
            }
            case Service.help: {
                const topic = this._commandLine(registers.y).trim().toUpperCase();
                if (topic === "") response.print(`  ${Title} ${Version}${Carriage}`);
                else if (topic === Title)
                    response.print(`${Title} ${Version}${Carriage}  VDFS${Carriage}  ${Commands}${Carriage}`);
                break;
            }
            case Service.select:
                if (registers.y === FilingSystemNumber) {
                    this._select(response);
                    registers.a = 0;
                }
                break;
        }
    }

    _select(response) {
        this._reselecting = this.selected;
        this.selected = true;
        response.claim();
    }

    // ---- Files ----

    _attributes(entry) {
        return entry.isDirectory ? 0 : FileAttributes | (entry.locked ? LockedAttribute : 0);
    }

    _objectType(entry) {
        if (!entry) return ObjectNone;
        return entry.isDirectory ? ObjectDirectory : ObjectFile;
    }

    _writeInformation(block, entry) {
        this._setLong(block + 2, entry.load);
        this._setLong(block + 6, entry.exec);
        this._setLong(block + 10, entry.isDirectory ? 0 : entry.length);
        this._setLong(block + 14, this._attributes(entry));
    }

    _file(registers) {
        const block = registers.x | (registers.y << 8);
        const name = this._filename(this._word(block));
        const { parent, name: leaf, entry } = this._resolve(name);
        const attributes = () => this._long(block + 14);
        switch (registers.a) {
            case 0x00: {
                const [load, exec, start, end] = [2, 6, 10, 14].map((offset) => this._long(block + offset));
                if (end < start) throw Errors.badAddress();
                if (entry?.isDirectory) throw Errors.isDirectory();
                const data = this._readMemory(start, end - start);
                const saved = this.volume.createFile(parent, leaf, { load, exec, data });
                this.volume.persist(saved);
                registers.a = ObjectFile;
                break;
            }
            case 0x01:
            case 0x02:
            case 0x03:
            case 0x04:
                if (entry) {
                    if (registers.a === 0x01 || registers.a === 0x02) entry.load = this._long(block + 2);
                    if (registers.a === 0x01 || registers.a === 0x03) entry.exec = this._long(block + 6);
                    if (registers.a === 0x01 || registers.a === 0x04)
                        entry.locked = (attributes() & LockedAttribute) !== 0;
                    if (!entry.isDirectory) this.volume.persist(entry);
                }
                registers.a = this._objectType(entry);
                break;
            case 0x05:
                if (entry) this._writeInformation(block, entry);
                registers.a = this._objectType(entry);
                break;
            case 0x06:
                if (entry) {
                    this._writeInformation(block, entry);
                    this.volume.remove(entry);
                }
                registers.a = this._objectType(entry);
                break;
            case 0x08:
                if (entry && !entry.isDirectory) throw Errors.exists();
                if (!entry) this.volume.makeDirectory(parent, leaf);
                registers.a = ObjectDirectory;
                break;
            case 0xff: {
                if (!entry) throw Errors.notFound();
                if (entry.isDirectory) throw Errors.isDirectory();
                const address = this._byte(block + 6) === 0 ? this._long(block + 2) : entry.load;
                this._writeMemory(address, entry.bytes);
                this._writeInformation(block, entry);
                this._setLong(block + 2, address);
                registers.a = ObjectFile;
                break;
            }
            default:
                throw Errors.unsupported(`OSFILE ${registers.a}`);
        }
    }

    // ---- Open files ----

    _channel(handle) {
        const channel = this._channels[handle - FirstHandle];
        if (!channel) throw Errors.notOpen();
        return channel;
    }

    _find(registers) {
        if (registers.a === 0) {
            if (registers.y === 0) this.closeAll();
            else this._close(registers.y);
            return;
        }
        const name = this._filename(registers.x | (registers.y << 8));
        const { parent, name: leaf, entry } = this._resolve(name);
        const kind = registers.a & 0xc0;
        let target = entry;
        if (kind === 0x80) target = this.volume.createFile(parent, leaf);
        else if (!entry) {
            registers.a = 0;
            return;
        }
        if (target.isDirectory) throw Errors.isDirectory();
        const slot = this._channels.indexOf(null);
        if (slot < 0) throw Errors.tooManyOpen();
        this._channels[slot] = new Channel(target, { writable: kind !== 0x40 });
        if (kind === 0x80) this._channels[slot].dirty = true;
        registers.a = FirstHandle + slot;
    }

    _close(handle) {
        const channel = this._channel(handle);
        this._channels[handle - FirstHandle] = null;
        this._flushChannel(channel);
    }

    _flushChannel(channel) {
        if (!channel.dirty) return;
        channel.dirty = false;
        this.volume.persist(channel.entry);
    }

    /** Hands what open files have had written to them to the store, leaving them open. */
    flushChannels() {
        for (const channel of this._channels) if (channel) this._flushChannel(channel);
    }

    closeAll() {
        this.flushChannels();
        this._channels.fill(null);
    }

    _args(registers) {
        if (registers.y === 0) {
            if (registers.a === 0) registers.a = FilingSystemNumber;
            else if (registers.a === 0xff) this.flushChannels();
            return;
        }
        const channel = this._channel(registers.y);
        const block = registers.x;
        const { entry } = channel;
        switch (registers.a) {
            case 0:
                this._setLong(block, channel.pointer);
                break;
            case 1:
                channel.pointer = this._long(block);
                break;
            case 2:
                this._setLong(block, entry.length);
                break;
            case 3:
                if (!channel.writable) throw Errors.locked();
                entry.resize(this._long(block));
                channel.dirty = true;
                break;
            case 0xff:
                this._flushChannel(channel);
                break;
        }
    }

    _bget(registers) {
        const channel = this._channel(registers.y);
        if (channel.pointer > channel.entry.length) throw Errors.eof();
        if (channel.pointer === channel.entry.length) {
            registers.a = 0xfe;
            registers.p |= Carry;
            return;
        }
        registers.a = channel.entry.buffer[channel.pointer++];
        registers.p &= ~Carry;
    }

    _bput(registers) {
        const channel = this._channel(registers.y);
        if (!channel.writable) throw Errors.locked();
        const { entry } = channel;
        if (channel.pointer >= entry.length) entry.resize(channel.pointer + 1);
        entry.buffer[channel.pointer++] = registers.a;
        channel.dirty = true;
    }

    _gbpb(registers) {
        if (registers.a < 1 || registers.a > 4) throw Errors.unsupported(`OSGBPB ${registers.a}`);
        const block = registers.x | (registers.y << 8);
        const channel = this._channel(this._byte(block));
        const address = this._long(block + 1);
        const count = this._long(block + 5);
        const { entry } = channel;
        if (registers.a === 1 || registers.a === 3) channel.pointer = this._long(block + 9);
        let transferred = count;
        if (registers.a <= 2) {
            if (!channel.writable) throw Errors.locked();
            if (channel.pointer + count > entry.length) entry.resize(channel.pointer + count);
            entry.buffer.set(this._readMemory(address, count), channel.pointer);
            channel.dirty = true;
        } else {
            transferred = Math.max(0, Math.min(count, entry.length - channel.pointer));
            this._writeMemory(address, entry.buffer.subarray(channel.pointer, channel.pointer + transferred));
        }
        channel.pointer += transferred;
        this._setLong(block + 1, address + transferred);
        this._setLong(block + 5, count - transferred);
        this._setLong(block + 9, channel.pointer);
        if (count - transferred > 0) registers.p |= Carry;
        else registers.p &= ~Carry;
    }

    // ---- Filing system calls and commands ----

    _fsc(registers, response) {
        const text = () => this._string(registers.x | (registers.y << 8));
        switch (registers.a) {
            case Fsc.option:
                if (registers.x === 4) this.bootOption = registers.y & 3;
                break;
            case Fsc.eof: {
                const channel = this._channel(registers.x);
                registers.x = channel.pointer >= channel.entry.length ? 0xff : 0;
                break;
            }
            case Fsc.slashRun:
            case Fsc.run:
                this._run(text(), response);
                break;
            case Fsc.unrecognised: {
                const { name, argument } = this._parseCommand(text());
                if (!this._runCommand(name, argument, response))
                    this._run(text(), response, { orElse: Errors.badCommand });
                break;
            }
            case Fsc.catalogue:
                this._catalogue(text().trim(), response);
                break;
            case Fsc.newFilingSystem:
                if (this._reselecting) this._reselecting = false;
                else {
                    this.selected = false;
                    this.closeAll();
                }
                break;
            case Fsc.handles:
                registers.x = FirstHandle;
                registers.y = LastHandle;
                break;
            case Fsc.examine:
                this._examine(text().trim(), response, { extended: true });
                break;
            case Fsc.info:
                this._examine(text().trim(), response, { extended: false });
                break;
        }
    }

    _parseCommand(line) {
        const match = /^[\s*]*(\S*)\s*(.*)$/.exec(line);
        return { name: match[1].toUpperCase(), argument: match[2].trim() };
    }

    _runCommand(name, argument, response) {
        switch (name) {
            case "DIR":
                this.directory = argument ? this._existingDirectory(argument) : this.volume.root;
                return true;
            case "LIB":
                this.library = argument ? this._existingDirectory(argument) : this.volume.root;
                return true;
            case "CDIR": {
                if (!argument) throw Errors.badName();
                const { parent, name: leaf, entry } = this._resolve(argument);
                if (entry) throw Errors.exists();
                this.volume.makeDirectory(parent, leaf);
                return true;
            }
            case "DELETE":
                if (!argument) throw Errors.badName();
                this.volume.remove(this._existing(argument));
                return true;
            case "ACCESS": {
                const [path, attributes = ""] = argument.split(/\s+/);
                if (!path) throw Errors.badName();
                const entry = this._existing(path);
                entry.locked = attributes.toUpperCase().includes("L");
                if (!entry.isDirectory) this.volume.persist(entry);
                return true;
            }
            case "INFO":
                this._examine(argument, response, { extended: false });
                return true;
            case "EX":
                this._examine(argument, response, { extended: true });
                return true;
            case "CAT":
                this._catalogue(argument, response);
                return true;
            default:
                return false;
        }
    }

    _existingDirectory(text) {
        const entry = this._existing(text);
        if (!entry.isDirectory) throw Errors.notDirectory();
        return entry;
    }

    /** `*RUN`: the file in the current directory, or failing that the library, loaded and then run. */
    _run(text, response, { orElse = Errors.notFound } = {}) {
        const { name } = this._parseCommand(text);
        const find = (cwd) => {
            try {
                return this.volume.resolve(name, { cwd, library: this.library }).entry;
            } catch (error) {
                if (error instanceof VdfsError) return undefined;
                throw error;
            }
        };
        const entry = find(this.directory) ?? find(this.library);
        if (!entry) throw orElse();
        if (entry.isDirectory) throw Errors.isDirectory();
        this._writeMemory(entry.load, entry.bytes);
        response.exec(this._memoryAddress(entry.exec));
    }

    _catalogue(argument, response) {
        const dir = argument ? this._existingDirectory(argument) : this.directory;
        let text = `${Title}${Carriage}Dir. ${dir.displayPath}  Lib. ${this.library.displayPath}${Carriage}${Carriage}`;
        dir.listing().forEach((entry, index) => {
            const flag = entry.isDirectory ? "D" : entry.locked ? "L" : " ";
            text += `${entry.name.padEnd(NameWidth)}${flag}`.padEnd(CatalogueColumnWidth);
            if (index % CataloguePerLine === CataloguePerLine - 1) text += Carriage;
        });
        if (!text.endsWith(Carriage)) text += Carriage;
        response.print(text);
    }

    _examine(argument, response, { extended }) {
        const entries = this._matching(argument);
        const line = (entry) => {
            const flag = entry.isDirectory ? "D" : entry.locked ? "L" : " ";
            const details = `${hex(entry.load, 8)} ${hex(entry.exec, 8)} ${hex(entry.isDirectory ? 0 : entry.length, 6)}`;
            return `${entry.name.padEnd(NameWidth)} ${flag} ${details}${Carriage}`;
        };
        let text = extended ? `Dir. ${this.directory.displayPath}${Carriage}` : "";
        for (const entry of entries) text += line(entry);
        response.print(text);
    }

    /** The entries a name with wildcards in its last part picks out, or with no name, all of the directory's. */
    _matching(argument) {
        if (!argument) return this.directory.listing();
        const lastDot = argument.lastIndexOf(".");
        const directory = lastDot < 0 ? this.directory : this._existingDirectory(argument.slice(0, lastDot) || "$");
        const matcher = wildcardMatcher(argument.slice(lastDot + 1));
        const found = directory.listing().filter((entry) => matcher.test(entry.name));
        if (found.length === 0) throw Errors.notFound();
        return found;
    }
}
