import { VdfsHost } from "../../src/vdfs-host.js";
import { Call, Op, Port } from "../../src/vdfs-protocol.js";
import { VdfsVolume } from "../../src/vdfs-volume.js";

export const Block = 0x2000;
export const Name = 0x2100;
export const Data = 0x3000;
const CommandLine = 0x2200;
const OsfileBlock = Object.freeze({ load: 2, exec: 6, start: 10, end: 14 });
const IdleFlags = 0x30;
const ServiceRomSlot = 13;

/** A store that remembers what it was asked to persist, as a map from path to what is there now. */
export class MemoryStore {
    constructor(items = []) {
        this.items = items;
        this.files = new Map();
        this.directories = new Set();
        this.log = [];
    }

    async load() {
        return this.items;
    }

    async writeFile(path, details) {
        this.log.push(["writeFile", path.join(".")]);
        this.files.set(path.join("."), details);
    }

    async makeDirectory(path) {
        this.log.push(["makeDirectory", path.join(".")]);
        this.directories.add(path.join("."));
    }

    async remove(path) {
        this.log.push(["remove", path.join(".")]);
        this.files.delete(path.join("."));
        this.directories.delete(path.join("."));
    }
}

export const file = (path, text = "", extra = {}) => ({
    path: path.split("."),
    isDirectory: false,
    data: new TextEncoder().encode(text),
    load: 0,
    exec: 0,
    locked: false,
    ...extra,
});

export const directory = (path) => ({ path: path.split("."), isDirectory: true });

export const text = (bytes) => new TextDecoder().decode(bytes);

/** The X and Y registers that point at `address`. */
export const xy = (address) => ({ x: address & 0xff, y: address >> 8 });

/** Just enough of a machine for the host: 64K of memory it can look at and change. */
export function fakeCpu({ hasTube = false } = {}) {
    const memory = new Uint8Array(0x10000);
    return {
        memory,
        hasTube,
        peekmem: (address) => memory[address & 0xffff],
        writemem: (address, value) => {
            memory[address & 0xffff] = value;
        },
    };
}

export function poke(cpu, address, bytes) {
    for (const [index, byte] of [...bytes].entries())
        cpu.memory[address + index] = typeof byte === "string" ? byte.charCodeAt(0) : byte;
}

/** Puts a string, with its return, in memory and gives its address. */
export function putString(cpu, address, string) {
    poke(cpu, address, [...string, 0x0d]);
    return address;
}

export function putLong(cpu, address, value) {
    for (let index = 0; index < 4; index++) cpu.memory[address + index] = (value >>> (8 * index)) & 0xff;
}

export function getLong(cpu, address) {
    return (
        (cpu.memory[address] |
            (cpu.memory[address + 1] << 8) |
            (cpu.memory[address + 2] << 16) |
            (cpu.memory[address + 3] << 24)) >>>
        0
    );
}

export const errorOf = (result) => result.ops.find((op) => op.op === "error");

export const printed = (result) =>
    result.ops
        .filter((op) => op.op === "print")
        .map((op) => op.text)
        .join("");

/** Reads a whole response from `host` as the ROM does: the ops, and the registers it ends with. */
export function readResponse(host, registersIn) {
    const stream = host.read(Port.stream);
    const readByte = () => {
        host.write(Port.stream, stream);
        return host.read(Port.data);
    };
    const readText = () => {
        let result = "";
        for (let byte = readByte(); byte !== 0; byte = readByte()) result += String.fromCharCode(byte);
        return result;
    };
    const ops = [];
    for (;;) {
        const op = readByte();
        if (op === Op.done) {
            const [x, y, p, a] = [readByte(), readByte(), readByte(), readByte()];
            return { ops, a, x, y, p };
        }
        if (op === Op.print) ops.push({ op: "print", text: readText() });
        else if (op === Op.claim) ops.push({ op: "claim" });
        else if (op === Op.exec) {
            const high = readByte();
            ops.push({ op: "exec", address: ((high << 8) | readByte()) + 1 });
        } else if (op === Op.error) {
            const number = readByte();
            ops.push({ op: "error", number, text: readText() });
            return { ops, ...registersIn };
        } else throw new Error(`unknown op ${op}`);
    }
}

/**
 * A host over a volume of `items`, on a fake machine, with `call()` to make calls as the ROM does and a shortcut for
 * each kind of call a test makes.
 */
export async function hostWith(items = [], { hasTube = false } = {}) {
    const store = new MemoryStore(items);
    const volume = await VdfsVolume.open(store);
    const cpu = fakeCpu({ hasTube });
    const host = new VdfsHost(cpu, volume);

    function call(number, { a = 0, x = 0, y = 0, p = IdleFlags } = {}) {
        for (const [port, value] of [
            [Port.a, a],
            [Port.x, x],
            [Port.y, y],
            [Port.p, p],
        ])
            host.write(port, value);
        host.write(Port.call, number);
        return readResponse(host, { a, x, y, p });
    }

    /** OSFILE `action` on `name`, with the rest of the control block as `fields`. */
    function osfile(action, name, { load = 0, exec = 0, start = 0, end = 0 } = {}) {
        putString(cpu, Name, name);
        cpu.memory[Block] = Name & 0xff;
        cpu.memory[Block + 1] = Name >> 8;
        putLong(cpu, Block + OsfileBlock.load, load);
        putLong(cpu, Block + OsfileBlock.exec, exec);
        putLong(cpu, Block + OsfileBlock.start, start);
        putLong(cpu, Block + OsfileBlock.end, end);
        return call(Call.file, { a: action, ...xy(Block) });
    }

    /** OSFIND `mode` on `name`; the handle is the result's A. */
    function open(name, mode) {
        putString(cpu, Name, name);
        return call(Call.find, { a: mode, ...xy(Name) });
    }

    /** A `*` command the OS did not know, which it hands to the filing system. */
    function command(line) {
        putString(cpu, Name, line);
        return call(Call.fsc, { a: 3, ...xy(Name) });
    }

    /** A service call, with `line` where the command line pointer says. */
    function service(a, { y = 0, line = "" } = {}) {
        putString(cpu, CommandLine, line);
        cpu.memory[0xf2] = CommandLine & 0xff;
        cpu.memory[0xf3] = CommandLine >> 8;
        return call(Call.service, { a, x: ServiceRomSlot, y });
    }

    return { host, volume, store, cpu, call, osfile, open, command, service, files: (path) => store.files.get(path) };
}
