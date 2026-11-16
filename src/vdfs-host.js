// The filing system behind the VDFS ROM in roms-src/vdfs: what the OS's filing system calls and the commands do to the
// volume's files, and to the 6502's memory. The device the ROM talks to is vdfs-protocol.js. See docs/vdfs.md.

import { ChannelTable, FirstHandle, LastHandle } from "./vdfs-channels.js";
import { Errors, VdfsError } from "./vdfs-errors.js";
import { GuestMemory } from "./vdfs-guest-memory.js";
import { hexUpper } from "./hex.js";
import { Call, VdfsPorts } from "./vdfs-protocol.js";
import { LockedAttribute, MaxNameLength, wildcardMatcher } from "./vdfs-volume.js";

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

const hasAddresses = (entry) => entry.load !== 0 || entry.exec !== 0;
const blockAddress = ({ x, y }) => x | (y << 8);
const accessFlag = (entry) => (entry.isDirectory ? "D" : entry.locked ? "L" : " ");

export class VdfsHost {
    /**
     * @param {import("./6502.js").Cpu6502} cpu the machine whose memory the files are read to and written from
     * @param {import("./vdfs-volume.js").VdfsVolume} volume the files
     */
    constructor(cpu, volume) {
        this.volume = volume;
        this.memory = new GuestMemory(cpu);
        this.channels = new ChannelTable(volume);
        this.ports = new VdfsPorts((call, registers, response) => this._dispatch(call, registers, response));
        /** @type {Error | null} why the volume could not be read, in which case it is empty */
        this.loadError = null;
        this._commands = {
            ACCESS: (argument) => this._access(argument),
            CAT: (argument, response) => this._catalogue(argument, response),
            CDIR: (argument) => this._makeDirectory(argument),
            DELETE: (argument) => this._delete(argument),
            DIR: (argument) => (this.directory = this._directoryNamed(argument)),
            EX: (argument, response) => this._examine(argument, response, { extended: true }),
            INFO: (argument, response) => this._examine(argument, response, { extended: false }),
            LIB: (argument) => (this.library = this._directoryNamed(argument)),
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

    /** Reads the volume's files. A volume that cannot be read is empty, and the machine goes on without it. */
    async load() {
        try {
            await this.volume.load();
        } catch (error) {
            console.error("VDFS could not read its files:", error);
            this.loadError = error;
        }
    }

    /** @returns {Promise<void>} once what the BBC has written, open files included, is in the store */
    async flush() {
        this.channels.flush();
        await this.volume.flush();
    }

    /** A break: the OS has gone back to its own filing system, and files open on the old one are closed. */
    reset() {
        this.ports.reset();
        this.channels.closeAll();
        this.selected = false;
        this._reselecting = false;
        this.directory = this.volume.root;
        this.library = this.volume.root;
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
                return this.channels.get(registers.y).writeByte(registers.a);
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

    _resolve(text) {
        return this.volume.resolve(text, { cwd: this.directory, library: this.library });
    }

    _existing(text) {
        const { entry } = this._resolve(text);
        if (!entry) throw Errors.notFound();
        return entry;
    }

    _commandLine(offset) {
        return this.memory.text(this.memory.word(CommandLinePointer) + offset);
    }

    // ---- Service calls ----

    _service(registers, response) {
        switch (registers.a) {
            case Service.command: {
                const { name, argument } = this._parseCommand(this._commandLine(registers.y));
                if (name === Title) {
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

    _file(registers) {
        const block = blockAddress(registers);
        const { parent, name: leaf, entry } = this._resolve(this.memory.filename(this.memory.word(block)));
        const action = registers.a;
        switch (action) {
            case Osfile.save:
                this._save(block, { parent, leaf, entry });
                registers.a = ObjectFile;
                break;
            case Osfile.writeInformation:
            case Osfile.writeLoad:
            case Osfile.writeExec:
            case Osfile.writeAttributes:
                if (entry) this._writeAttributes(action, block, entry);
                registers.a = this._objectType(entry);
                break;
            case Osfile.readInformation:
                if (entry) this._writeInformation(block, entry);
                registers.a = this._objectType(entry);
                break;
            case Osfile.delete:
                if (entry) {
                    this._writeInformation(block, entry);
                    this._remove(entry);
                }
                registers.a = this._objectType(entry);
                break;
            case Osfile.createDirectory:
                if (entry && !entry.isDirectory) throw Errors.exists();
                if (!entry) this.volume.makeDirectory(parent, leaf);
                registers.a = ObjectDirectory;
                break;
            case Osfile.load:
                this._load(block, entry);
                registers.a = ObjectFile;
                break;
            default:
                throw Errors.unsupported(`OSFILE ${action}`);
        }
    }

    _save(block, { parent, leaf, entry }) {
        const [load, exec, start, end] = [OsfileBlock.load, OsfileBlock.exec, OsfileBlock.start, OsfileBlock.end].map(
            (offset) => this.memory.long(block + offset),
        );
        if (end < start) throw Errors.badAddress();
        if (entry?.isDirectory) throw Errors.isDirectory();
        const data = this.memory.read(start, end - start);
        this.volume.persist(this.volume.createFile(parent, leaf, { load, exec, data }));
    }

    _writeAttributes(action, block, entry) {
        const all = action === Osfile.writeInformation;
        if (all || action === Osfile.writeLoad) entry.load = this.memory.long(block + OsfileBlock.load);
        if (all || action === Osfile.writeExec) entry.exec = this.memory.long(block + OsfileBlock.exec);
        if (all || action === Osfile.writeAttributes)
            entry.locked = (this.memory.long(block + OsfileBlock.attributes) & LockedAttribute) !== 0;
        if (!entry.isDirectory) this.volume.persist(entry);
    }

    _load(block, entry) {
        if (!entry) throw Errors.notFound();
        if (entry.isDirectory) throw Errors.isDirectory();
        const atOwnAddress = this.memory.byte(block + OsfileBlock.exec) !== 0;
        if (atOwnAddress && !hasAddresses(entry)) throw Errors.noAddresses();
        const address = atOwnAddress ? entry.load : this.memory.long(block + OsfileBlock.load);
        this.memory.write(address, entry.bytes);
        this._writeInformation(block, entry);
        this.memory.setLong(block + OsfileBlock.load, address);
    }

    // ---- Open files ----

    _find(registers) {
        if (registers.a === Osfind.close) {
            if (registers.y === 0) this.channels.closeAll();
            else this.channels.close(registers.y);
            return;
        }
        const { parent, name: leaf, entry } = this._resolve(this.memory.filename(blockAddress(registers)));
        const mode = registers.a & OsfindModeMask;
        let target = entry;
        if (mode === Osfind.write) target = this.volume.createFile(parent, leaf);
        else if (!entry) {
            registers.a = 0;
            return;
        }
        if (target.isDirectory) throw Errors.isDirectory();
        if (mode === Osfind.update && target.locked) throw Errors.locked();
        registers.a = this.channels.open(target, { writable: mode !== Osfind.read, dirty: mode === Osfind.write });
    }

    _args(registers) {
        if (registers.y === 0) {
            if (registers.a === OsargsFilingSystem) registers.a = FilingSystemNumber;
            else if (registers.a === Osargs.flush) this.channels.flush();
            return;
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
                this.channels.flushChannel(channel);
                break;
        }
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

    _fsc(registers, response) {
        const text = () => this.memory.text(blockAddress(registers));
        switch (registers.a) {
            case Fsc.eof:
                registers.x = this.channels.get(registers.x).atEnd ? EndOfFile : 0;
                break;
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
                    this.channels.closeAll();
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

    /** @returns {boolean} whether `name` is one of the commands, which has then been run */
    _runCommand(name, argument, response) {
        if (!Object.hasOwn(this._commands, name)) return false;
        this._commands[name](argument, response);
        return true;
    }

    _directoryNamed(argument) {
        if (!argument) return this.volume.root;
        const entry = this._existing(argument);
        if (!entry.isDirectory) throw Errors.notDirectory();
        return entry;
    }

    _makeDirectory(argument) {
        if (!argument) throw Errors.badName();
        const { parent, name, entry } = this._resolve(argument);
        if (entry) throw Errors.exists();
        this.volume.makeDirectory(parent, name);
    }

    _delete(argument) {
        if (!argument) throw Errors.badName();
        this._remove(this._existing(argument));
    }

    _access(argument) {
        const [path, attributes = ""] = argument.split(/\s+/);
        if (!path) throw Errors.badName();
        const entry = this._existing(path);
        entry.locked = attributes.toUpperCase().includes("L");
        if (!entry.isDirectory) this.volume.persist(entry);
    }

    /** Removes an entry, and puts the current directory and the library back at the root if it was either. */
    _remove(entry) {
        this.volume.remove(entry);
        if (this.directory === entry) this.directory = this.volume.root;
        if (this.library === entry) this.library = this.volume.root;
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
        if (!hasAddresses(entry)) throw Errors.noAddresses();
        this.memory.write(entry.load, entry.bytes);
        response.exec(this.memory.address(entry.exec));
    }

    _catalogue(argument, response) {
        const dir = argument ? this._directoryNamed(argument) : this.directory;
        let text = `${Title}${Carriage}Dir. ${dir.displayPath}  Lib. ${this.library.displayPath}${Carriage}${Carriage}`;
        dir.listing().forEach((entry, index) => {
            text += `${entry.name.padEnd(MaxNameLength)}${accessFlag(entry)}`.padEnd(CatalogueColumnWidth);
            if (index % CataloguePerLine === CataloguePerLine - 1) text += Carriage;
        });
        if (!text.endsWith(Carriage)) text += Carriage;
        response.print(text);
    }

    _examine(argument, response, { extended }) {
        const line = (entry) => {
            const details = `${hexUpper(entry.load, 8)} ${hexUpper(entry.exec, 8)} ${hexUpper(entry.size, 6)}`;
            return `${entry.name.padEnd(MaxNameLength)} ${accessFlag(entry)} ${details}${Carriage}`;
        };
        let text = extended ? `Dir. ${this.directory.displayPath}${Carriage}` : "";
        for (const entry of this._matching(argument)) text += line(entry);
        response.print(text);
    }

    /** The entries a name with wildcards in its last part picks out, or with no name, all of the directory's. */
    _matching(argument) {
        if (!argument) return this.directory.listing();
        const lastDot = argument.lastIndexOf(".");
        const directory = lastDot < 0 ? this.directory : this._directoryNamed(argument.slice(0, lastDot) || "$");
        const matcher = wildcardMatcher(argument.slice(lastDot + 1));
        const found = directory.listing().filter((entry) => matcher.test(entry.name));
        if (found.length === 0) throw Errors.notFound();
        return found;
    }
}
