// The filing system behind the VDFS ROM in roms-src/vdfs: what the OS's filing system calls and the commands do to the
// store's files, and to the 6502's memory. The store is asked as it is needed, and the ROM waits for the answer. The
// device the ROM talks to is vdfs-protocol.js. See docs/vdfs.md.

import { Channel, ChannelTable, FirstHandle, LastHandle } from "./vdfs-channels.js";
import { Errors, VdfsError } from "./vdfs-errors.js";
import { GuestMemory } from "./vdfs-guest-memory.js";
import { hexUpper } from "./hex.js";
import { LockedAttribute, MaxNameLength, parsePath, sameName, wildcardMatcher } from "./vdfs-names.js";
import { Call, VdfsPorts } from "./vdfs-protocol.js";

export const FilingSystemNumber = 0x11;

export const Osfile = Object.freeze({
    save: 0x00,
    writeInformation: 0x01,
    writeLoad: 0x02,
    writeExec: 0x03,
    writeAttributes: 0x04,
    readInformation: 0x05,
    delete: 0x06,
    createDirectory: 0x08,
    load: 0xff,
});
export const Osfind = Object.freeze({ close: 0x00, read: 0x40, write: 0x80, update: 0xc0 });
export const Osargs = Object.freeze({ pointer: 0, setPointer: 1, extent: 2, setExtent: 3, flush: 0xff });
export const Osgbpb = Object.freeze({ writeAtPointer: 1, write: 2, readAtPointer: 3, read: 4 });

const Title = "VDFS";
const Version = "0.1";

const Service = Object.freeze({ command: 0x04, help: 0x09, select: 0x12 });
const Fsc = Object.freeze({
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
const OsfindModeMask = 0xc0;
const OsargsFilingSystem = 0;
const CommandLinePointer = 0xf2;
const FileAttributes = 0x03;
const Carriage = "\r";
const CataloguePerLine = 3;
const CatalogueColumnWidth = 13;
const EndOfFile = 0xff;
const NoMoreBytes = 0xfe;
const OsfileBlock = Object.freeze({ load: 2, exec: 6, start: 10, length: 10, end: 14, attributes: 14 });
const GbpbBlock = Object.freeze({ handle: 0, address: 1, count: 5, pointer: 9 });
const ObjectNone = 0;
const ObjectFile = 1;
const ObjectDirectory = 2;

const IpcPrefix = /^Error invoking remote method '[^']*': (Error: )?/;
const MissingErrors = new Set([Errors.notFound().number, Errors.badName().number, Errors.notDirectory().number]);
const hasAddresses = (entry) => entry.load !== 0 || entry.exec !== 0;
const blockAddress = ({ x, y }) => x | (y << 8);
const accessFlag = (entry) => (entry.isDirectory ? "D" : entry.locked ? "L" : " ");
const samePath = (a, b) => a.length === b.length && a.every((name, index) => sameName(name, b[index]));
const byName = (a, b) => a.name.toUpperCase().localeCompare(b.name.toUpperCase());
const directoryAt = (path) => ({
    parent: path.slice(0, -1),
    name: path.at(-1) ?? "$",
    path,
    entry: { name: path.at(-1) ?? "$", isDirectory: true, size: 0, load: 0, exec: 0, locked: false },
});

export class VdfsHost {
    /**
     * @param {import("./6502.js").Cpu6502} cpu the machine whose memory the files are read to and written from
     * @param {object} store the files, which it is asked for as they are needed: `find(directory, name)`,
     *   `list(directory)`, `read(path)`, `writeFile(path, {data, load, exec, locked})`, `setInfo(path, changes)`,
     *   `makeDirectory(path)` and `remove(path)`, each returning a promise. See vdfs-fs-store.js
     */
    constructor(cpu, store) {
        this.store = store;
        this.memory = new GuestMemory(cpu);
        this.channels = new ChannelTable();
        this.ports = new VdfsPorts((call, registers, response, turn) =>
            this._dispatch(call, registers, response, turn),
        );
        /** @type {(error: Error) => void} called when a file that was open could not be written, once the BBC has gone */
        this.onWriteFailure = (error) => console.error("VDFS could not write a file:", error);
        this._writes = new Set();
        /** @type {Promise<void> | null} while there is one, calls wait for it: the folder is changing */
        this._held = null;
        this._release = null;
        this._commands = {
            ACCESS: (argument, response, fs) => this._access(argument, fs),
            CAT: (argument, response, fs) => this._catalogue(argument, response, fs),
            CDIR: (argument, response, fs) => this._makeDirectory(argument, fs),
            DELETE: (argument, response, fs) => this._delete(argument, fs),
            DIR: async (argument, response, fs) => (this.directory = await this._directoryNamed(argument, fs)),
            EX: (argument, response, fs) => this._examine(argument, response, { extended: true }, fs),
            INFO: (argument, response, fs) => this._examine(argument, response, { extended: false }, fs),
            SETINFO: (argument, response, fs) => this._setInfo(argument, fs),
            LIB: async (argument, response, fs) => (this.library = await this._directoryNamed(argument, fs)),
        };
        this.reset();
    }

    get openStreams() {
        return this.ports.openStreams;
    }

    read(offset) {
        return this.ports.read(offset);
    }

    write(offset, value) {
        this.ports.write(offset, value);
    }

    /** A break: the OS has gone back to its own filing system, and files open on the old one are closed. */
    reset() {
        this.ports.reset();
        this._backgroundWriteBack(this.channels.takeAll());
        this.selected = false;
        this._reselecting = false;
        this.directory = [];
        this.library = [];
    }

    /** @returns {Promise<void>} once what the BBC has written, open files included, is in the store */
    async flush() {
        this._backgroundWriteBack(this.channels.all());
        await Promise.allSettled([...this._writes]);
    }

    /** Closes every file, written back, and the current directory and library are the root's. */
    async closeAll() {
        this._backgroundWriteBack(this.channels.takeAll());
        this.directory = [];
        this.library = [];
        await Promise.allSettled([...this._writes]);
    }

    /**
     * For a store that is about to change: a call that is waiting is ended with "Disc changed", every file is written
     * to the store it came from and closed, and calls made from now on wait until `release()`.
     */
    async hold() {
        this.ports.abort(Errors.discChanged());
        this.release();
        this._held = new Promise((resolve) => (this._release = resolve));
        await this.closeAll();
    }

    /** Lets the calls that have waited go on, to the store there is now. */
    release() {
        this._release?.();
        this._held = null;
        this._release = null;
    }

    /** Writes each file back, reporting the ones that cannot be, and going on to the rest. */
    async _writeBackEach(channels) {
        const fs = this._via(null);
        for (const channel of channels) {
            try {
                await this._writeBack(channel, fs);
            } catch (error) {
                this._reportWriteFailure(error);
            }
        }
    }

    _reportWriteFailure(error) {
        try {
            this.onWriteFailure(error);
        } catch (reporting) {
            console.error("VDFS could not report a write failure:", reporting);
        }
    }

    _backgroundWriteBack(channels) {
        if (channels.length === 0) return;
        const tracked = this._writeBackEach(channels).finally(() => this._writes.delete(tracked));
        this._writes.add(tracked);
    }

    /** The store, as a call uses it: what it throws is the BBC's error, and a break stops the call that was waiting. */
    _via(turn) {
        const wrap =
            (method) =>
            async (...args) => {
                let result;
                try {
                    result = await this.store[method](...args);
                } catch (error) {
                    throw error instanceof VdfsError ? error : Errors.discFault(error.message.replace(IpcPrefix, ""));
                }
                turn?.check();
                return result;
            };
        return Object.fromEntries(
            ["find", "list", "read", "writeFile", "setInfo", "makeDirectory", "remove"].map((method) => [
                method,
                wrap(method),
            ]),
        );
    }

    /** @returns {Promise<unknown> | null} what a call has to wait for before it is done: a folder change, or writes owed */
    _mustWait() {
        if (this._held) return this._held;
        return this._writes.size > 0 ? Promise.allSettled([...this._writes]) : null;
    }

    _dispatch(call, registers, response, turn) {
        const waiting = this._mustWait();
        if (waiting)
            return waiting.then(() => {
                turn.check();
                return this._dispatch(call, registers, response, turn);
            });
        const fs = this._via(turn);
        switch (call) {
            case Call.service:
                return this._service(registers, response, fs);
            case Call.file:
                return this._file(registers, fs);
            case Call.args:
                return this._args(registers, fs);
            case Call.bget:
                return this._bget(registers);
            case Call.bput:
                return this.channels.get(registers.y).writeByte(registers.a);
            case Call.gbpb:
                return this._gbpb(registers);
            case Call.find:
                return this._find(registers, fs);
            case Call.fsc:
                return this._fsc(registers, response, fs);
            default:
                throw new Error(`unknown call ${call}`);
        }
    }

    // ---- Names ----

    /**
     * Follows a name as the 6502 spells it, a part at a time.
     *
     * @returns {Promise<{parent: string[], name: string, path: string[], entry: object | null}>} the directory the last
     *   part is in, its name as the store has it, the whole path, and what the store says is there
     */
    async _resolve(text, fs, { current = this.directory } = {}) {
        const { base, parts } = parsePath(text);
        let directory = base === "root" ? [] : base === "library" ? this.library : current;
        if (parts.length === 0) return directoryAt(directory);
        for (const part of parts.slice(0, -1)) directory = await this._step(directory, part, fs);
        const last = parts.at(-1);
        if (last === "^" || last === "@") return directoryAt(await this._step(directory, last, fs));
        const entry = await fs.find(directory, last);
        const name = entry?.name ?? last;
        return { parent: directory, name, path: [...directory, name], entry };
    }

    async _step(directory, part, fs) {
        if (part === "^") return directory.slice(0, -1);
        if (part === "@") return directory;
        const entry = await fs.find(directory, part);
        if (!entry) throw Errors.notFound();
        if (!entry.isDirectory) throw Errors.notDirectory();
        return [...directory, entry.name];
    }

    async _existing(text, fs) {
        const found = await this._resolve(text, fs);
        if (!found.entry) throw Errors.notFound();
        return found;
    }

    /** @returns {Promise<string[]>} the path of the directory a name gives, the root's for no name */
    async _directoryNamed(argument, fs) {
        if (!argument) return [];
        const { path, entry } = await this._existing(argument, fs);
        if (!entry.isDirectory) throw Errors.notDirectory();
        return path;
    }

    _commandLine(offset) {
        return this.memory.text(this.memory.word(CommandLinePointer) + offset);
    }

    _display(path) {
        return ["$", ...path].join(".");
    }

    // ---- Service calls ----

    _service(registers, response, fs) {
        switch (registers.a) {
            case Service.command: {
                const { name, argument } = this._parseCommand(this._commandLine(registers.y));
                if (name === Title) {
                    this._select(response);
                    registers.a = 0;
                } else if (this.selected) {
                    const outcome = this._runCommand(name, argument, response, fs);
                    if (outcome) return outcome.then(() => (registers.a = 0));
                }
                break;
            }
            case Service.help: {
                const topic = this._commandLine(registers.y).trim().toUpperCase();
                if (topic === "") response.print(`  ${Title} ${Version}${Carriage}`);
                else if (topic === Title) {
                    const names = [Title, ...Object.keys(this._commands)].sort().join(" ");
                    response.print(`${Title} ${Version}${Carriage}  ${Title}${Carriage}  ${names}${Carriage}`);
                }
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

    // ---- OSFILE ----

    _attributes(entry) {
        return entry.isDirectory ? 0 : FileAttributes | (entry.locked ? LockedAttribute : 0);
    }

    _objectType(entry) {
        if (!entry) return ObjectNone;
        return entry.isDirectory ? ObjectDirectory : ObjectFile;
    }

    _writeInformation(block, entry) {
        this.memory.setLong(block + OsfileBlock.load, entry.load);
        this.memory.setLong(block + OsfileBlock.exec, entry.exec);
        this.memory.setLong(block + OsfileBlock.length, entry.size);
        this.memory.setLong(block + OsfileBlock.attributes, this._attributes(entry));
    }

    async _file(registers, fs) {
        const block = blockAddress(registers);
        const found = await this._resolve(this.memory.filename(this.memory.word(block)), fs);
        const action = registers.a;
        switch (action) {
            case Osfile.save:
                await this._save(block, found, fs);
                registers.a = ObjectFile;
                break;
            case Osfile.writeInformation:
            case Osfile.writeLoad:
            case Osfile.writeExec:
            case Osfile.writeAttributes:
                if (found.entry && !found.entry.isDirectory) await fs.setInfo(found.path, this._changes(action, block));
                registers.a = this._objectType(found.entry);
                break;
            case Osfile.readInformation:
                if (found.entry) this._writeInformation(block, found.entry);
                registers.a = this._objectType(found.entry);
                break;
            case Osfile.delete:
                if (found.entry) {
                    this._writeInformation(block, found.entry);
                    await this._remove(found, fs);
                }
                registers.a = this._objectType(found.entry);
                break;
            case Osfile.createDirectory:
                if (found.entry && !found.entry.isDirectory) throw Errors.exists();
                if (!found.entry) await fs.makeDirectory(found.path);
                registers.a = ObjectDirectory;
                break;
            case Osfile.load:
                await this._load(block, found, fs);
                registers.a = ObjectFile;
                break;
            default:
                throw Errors.unsupported(`OSFILE ${action}`);
        }
    }

    async _save(block, { path, entry }, fs) {
        const [load, exec, start, end] = [OsfileBlock.load, OsfileBlock.exec, OsfileBlock.start, OsfileBlock.end].map(
            (offset) => this.memory.long(block + offset),
        );
        if (end < start) throw Errors.badAddress();
        if (entry?.isDirectory) throw Errors.isDirectory();
        if (entry?.locked) throw Errors.locked();
        const data = this.memory.read(start, end - start);
        this.channels.detachPath(path);
        await fs.writeFile(path, { data, load, exec, locked: false });
    }

    /** What an OSFILE that writes a file's information changes: the addresses, the lock, or all of them. */
    _changes(action, block) {
        const all = action === Osfile.writeInformation;
        const changes = {};
        if (all || action === Osfile.writeLoad) changes.load = this.memory.long(block + OsfileBlock.load);
        if (all || action === Osfile.writeExec) changes.exec = this.memory.long(block + OsfileBlock.exec);
        if (all || action === Osfile.writeAttributes)
            changes.locked = (this.memory.long(block + OsfileBlock.attributes) & LockedAttribute) !== 0;
        return changes;
    }

    async _load(block, { path, entry }, fs) {
        if (!entry) throw Errors.notFound();
        if (entry.isDirectory) throw Errors.isDirectory();
        const atOwnAddress = this.memory.byte(block + OsfileBlock.exec) !== 0;
        if (atOwnAddress && !hasAddresses(entry)) throw Errors.noAddresses();
        const address = atOwnAddress ? entry.load : this.memory.long(block + OsfileBlock.load);
        const data = await fs.read(path);
        this.memory.write(address, data);
        this._writeInformation(block, { ...entry, size: data.length });
        this.memory.setLong(block + OsfileBlock.load, address);
    }

    // ---- Open files ----

    _find(registers, fs) {
        if (registers.a !== Osfind.close) return this._open(registers, fs);
        return registers.y === 0 ? this._closeOpen(fs) : this._close(this.channels.get(registers.y), fs);
    }

    async _open(registers, fs) {
        const { path, entry } = await this._resolve(this.memory.filename(blockAddress(registers)), fs);
        const mode = registers.a & OsfindModeMask;
        if (entry?.isDirectory) throw Errors.isDirectory();
        let data;
        let info;
        if (mode === Osfind.write) {
            if (entry?.locked) throw Errors.locked();
            this.channels.requireRoom();
            this.channels.detachPath(path);
            data = new Uint8Array(0);
            info = { load: 0, exec: 0, locked: false };
            await fs.writeFile(path, { data, ...info });
        } else {
            if (!entry) {
                registers.a = 0;
                return;
            }
            if (mode === Osfind.update && entry.locked) throw Errors.locked();
            this.channels.requireRoom();
            data = await fs.read(path);
            info = { load: entry.load, exec: entry.exec, locked: entry.locked };
        }
        registers.a = this.channels.open(new Channel({ path, data, info, writable: mode !== Osfind.read }));
    }

    /**
     * Writes a file that has been written to back to the store, once, unless it has been deleted or replaced since.
     * It is not marked as written until it is, and again as not if it is not, for the BBC may write to it meanwhile.
     *
     * @returns {Promise<void> | undefined} nothing to wait for, when there is nothing to write
     */
    _writeBack(channel, fs) {
        if (!channel.dirty || channel.detached) return undefined;
        channel.dirty = false;
        return fs.writeFile(channel.path, { data: channel.bytes.slice(), ...channel.info }).catch((error) => {
            channel.dirty = true;
            throw error;
        });
    }

    /** Closes a file once it is written back, so that one that cannot be written is still there to be written again. */
    _close(channel, fs) {
        const writing = this._writeBack(channel, fs);
        if (!writing) return this.channels.release(channel);
        return writing.then(() => this.channels.release(channel));
    }

    /** Closes every file, stopping at one that cannot be written, and leaving it and the rest open. */
    _closeOpen(fs) {
        const open = this.channels.all();
        if (!open.some((channel) => channel.dirty && !channel.detached))
            return open.forEach((channel) => this.channels.release(channel));
        return (async () => {
            for (const channel of open) await this._close(channel, fs);
        })();
    }

    /** Writes every file back that needs it, leaving them open. */
    _flushOpen(fs) {
        const dirty = this.channels.all().filter((channel) => channel.dirty && !channel.detached);
        if (dirty.length === 0) return undefined;
        return (async () => {
            for (const channel of dirty) await this._writeBack(channel, fs);
        })();
    }

    _args(registers, fs) {
        if (registers.y === 0) {
            if (registers.a === OsargsFilingSystem) registers.a = FilingSystemNumber;
            else if (registers.a === Osargs.flush) return this._flushOpen(fs);
            return undefined;
        }
        const channel = this.channels.get(registers.y);
        const block = registers.x;
        switch (registers.a) {
            case Osargs.pointer:
                this.memory.setLong(block, channel.pointer);
                break;
            case Osargs.setPointer:
                channel.pointer = this.memory.long(block);
                break;
            case Osargs.extent:
                this.memory.setLong(block, channel.length);
                break;
            case Osargs.setExtent:
                channel.setLength(this.memory.long(block));
                break;
            case Osargs.flush:
                return this._writeBack(channel, fs);
        }
        return undefined;
    }

    _bget(registers) {
        const byte = this.channels.get(registers.y).readByte();
        if (byte === undefined) {
            registers.a = NoMoreBytes;
            registers.p |= Carry;
        } else {
            registers.a = byte;
            registers.p &= ~Carry;
        }
    }

    _gbpb(registers) {
        const action = registers.a;
        if (!Object.values(Osgbpb).includes(action)) throw Errors.unsupported(`OSGBPB ${action}`);
        const block = blockAddress(registers);
        const channel = this.channels.get(this.memory.byte(block + GbpbBlock.handle));
        const address = this.memory.long(block + GbpbBlock.address);
        const count = this.memory.long(block + GbpbBlock.count);
        if (action === Osgbpb.writeAtPointer || action === Osgbpb.readAtPointer)
            channel.pointer = this.memory.long(block + GbpbBlock.pointer);
        let transferred = count;
        if (action === Osgbpb.writeAtPointer || action === Osgbpb.write) {
            channel.write(this.memory.read(address, count));
        } else {
            const bytes = channel.peek(count);
            this.memory.write(address, bytes);
            channel.pointer += bytes.length;
            transferred = bytes.length;
        }
        this.memory.setLong(block + GbpbBlock.address, address + transferred);
        this.memory.setLong(block + GbpbBlock.count, count - transferred);
        this.memory.setLong(block + GbpbBlock.pointer, channel.pointer);
        if (count > transferred) registers.p |= Carry;
        else registers.p &= ~Carry;
    }

    // ---- Filing system calls and commands ----

    _fsc(registers, response, fs) {
        const text = () => this.memory.text(blockAddress(registers));
        switch (registers.a) {
            case Fsc.eof:
                registers.x = this.channels.get(registers.x).atEnd ? EndOfFile : 0;
                break;
            case Fsc.slashRun:
            case Fsc.run:
                return this._run(text(), response, fs);
            case Fsc.unrecognised:
                return this._unrecognised(text(), response, fs);
            case Fsc.catalogue:
                return this._catalogue(text().trim(), response, fs);
            case Fsc.newFilingSystem:
                if (this._reselecting) this._reselecting = false;
                else {
                    this.selected = false;
                    return this._closeOpen(fs);
                }
                break;
            case Fsc.handles:
                registers.x = FirstHandle;
                registers.y = LastHandle;
                break;
            case Fsc.examine:
                return this._examine(text().trim(), response, { extended: true }, fs);
            case Fsc.info:
                return this._examine(text().trim(), response, { extended: false }, fs);
        }
        return undefined;
    }

    async _unrecognised(line, response, fs) {
        const { name, argument } = this._parseCommand(line);
        if (!(await this._runCommand(name, argument, response, fs)))
            await this._run(line, response, fs, { orElse: Errors.badCommand });
    }

    _parseCommand(line) {
        const match = /^[\s*]*(\S*)\s*(.*)$/.exec(line);
        return { name: match[1].toUpperCase(), argument: match[2].trim() };
    }

    /** @returns {Promise<boolean> | false} false if `name` is not one of the commands, else the command, run */
    _runCommand(name, argument, response, fs) {
        if (!Object.hasOwn(this._commands, name)) return false;
        return Promise.resolve(this._commands[name](argument, response, fs)).then(() => true);
    }

    async _makeDirectory(argument, fs) {
        if (!argument) throw Errors.badName();
        const { path, entry } = await this._resolve(argument, fs);
        if (entry) throw Errors.exists();
        await fs.makeDirectory(path);
    }

    async _delete(argument, fs) {
        if (!argument) throw Errors.badName();
        await this._remove(await this._existing(argument, fs), fs);
    }

    async _access(argument, fs) {
        const [name, attributes = ""] = argument.split(/\s+/);
        if (!name) throw Errors.badName();
        const { path, entry } = await this._existing(name, fs);
        if (!entry.isDirectory) await fs.setInfo(path, { locked: attributes.toUpperCase().includes("L") });
    }

    /** `*SETINFO name load [exec]`: the addresses are hexadecimal, and exec stays as it was if it is left out. */
    async _setInfo(argument, fs) {
        const [name, load, exec] = argument.split(/\s+/);
        if (!name) throw Errors.badName();
        const parse = (text) => {
            const digits = text.replace(/^&/, "");
            if (!/^[0-9a-f]{1,8}$/i.test(digits)) throw Errors.badAddress();
            return parseInt(digits, 16);
        };
        if (load === undefined) throw Errors.badAddress();
        const changes = { load: parse(load) };
        if (exec !== undefined) changes.exec = parse(exec);
        const { path, entry } = await this._existing(name, fs);
        if (entry.isDirectory) throw Errors.accessViolation();
        if (entry.locked) throw Errors.locked();
        await fs.setInfo(path, changes);
    }

    /** Removes a file, or a directory with nothing in it, and puts the current directory and library back at the root if it was. */
    async _remove({ path, entry }, fs) {
        if (path.length === 0) throw Errors.accessViolation();
        if (entry.locked) throw Errors.locked();
        if (entry.isDirectory) {
            const listing = await fs.list(path);
            if (listing && (listing.entries.length > 0 || listing.skipped.length > 0)) throw Errors.notEmpty();
        }
        this.channels.detachPath(path);
        await fs.remove(path);
        if (samePath(this.directory, path)) this.directory = [];
        if (samePath(this.library, path)) this.library = [];
    }

    /** `*RUN`: the file in the current directory, or failing that the library, loaded and then run. */
    async _run(text, response, fs, { orElse = Errors.notFound } = {}) {
        const { name } = this._parseCommand(text);
        const lookup = async (current) => {
            try {
                return await this._resolve(name, fs, { current });
            } catch (error) {
                if (error instanceof VdfsError && MissingErrors.has(error.number)) return undefined;
                throw error;
            }
        };
        const found = [await lookup(this.directory), await lookup(this.library)].find((where) => where?.entry);
        if (!found) throw orElse();
        const { path, entry } = found;
        if (entry.isDirectory) throw Errors.isDirectory();
        if (!hasAddresses(entry)) throw Errors.noAddresses();
        const exec = this.memory.address(entry.exec);
        this.memory.write(entry.load, await fs.read(path));
        response.exec(exec);
    }

    async _list(path, fs) {
        const listing = await fs.list(path);
        if (!listing) throw Errors.notFound();
        return { entries: listing.entries.sort(byName), skipped: listing.skipped };
    }

    async _catalogue(argument, response, fs) {
        const path = argument ? await this._directoryNamed(argument, fs) : this.directory;
        const { entries, skipped } = await this._list(path, fs);
        let text = `${Title}${Carriage}Dir. ${this._display(path)}  Lib. ${this._display(this.library)}${Carriage}${Carriage}`;
        entries.forEach((entry, index) => {
            text += `${entry.name.padEnd(MaxNameLength)}${accessFlag(entry)}`.padEnd(CatalogueColumnWidth);
            if (index % CataloguePerLine === CataloguePerLine - 1) text += Carriage;
        });
        if (!text.endsWith(Carriage)) text += Carriage;
        if (skipped.length > 0)
            text += `${skipped.length} not shown: the BBC cannot name ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? " and more" : ""}${Carriage}`;
        response.print(text);
    }

    async _examine(argument, response, { extended }, fs) {
        const line = (entry) => {
            const details = `${hexUpper(entry.load, 8)} ${hexUpper(entry.exec, 8)} ${hexUpper(entry.size, 6)}`;
            return `${entry.name.padEnd(MaxNameLength)} ${accessFlag(entry)} ${details}${Carriage}`;
        };
        let text = extended ? `Dir. ${this._display(this.directory)}${Carriage}` : "";
        for (const entry of await this._matching(argument, fs)) text += line(entry);
        response.print(text);
    }

    /** The entries a name with wildcards in its last part picks out, or with no name, all of the directory's. */
    async _matching(argument, fs) {
        if (!argument) return (await this._list(this.directory, fs)).entries;
        const lastDot = argument.lastIndexOf(".");
        const directory =
            lastDot < 0 ? this.directory : await this._directoryNamed(argument.slice(0, lastDot) || "$", fs);
        const matcher = wildcardMatcher(argument.slice(lastDot + 1));
        const found = (await this._list(directory, fs)).entries.filter((entry) => matcher.test(entry.name));
        if (found.length === 0) throw Errors.notFound();
        return found;
    }
}
