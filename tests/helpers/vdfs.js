import { VdfsHost } from "../../src/vdfs-host.js";
import { Busy, Call, Op, Port } from "../../src/vdfs-protocol.js";

export const Block = 0x2000;
export const Name = 0x2100;
export const Data = 0x3000;
const CommandLine = 0x2200;
const OsfileBlock = Object.freeze({ load: 2, exec: 6, start: 10, end: 14 });
const IdleFlags = 0x30;
const ServiceRomSlot = 13;

const keyOf = (path) => path.map((name) => name.toUpperCase()).join("\u0000");

/**
 * A store of files in memory, which remembers what it was asked to change. Each of its calls takes a moment, as a
 * folder's would.
 */
export class MemoryStore {
    constructor(items = []) {
        this.nodes = new Map();
        /** @type {string[]} the names of files it says it cannot give names to */
        this.skipped = [];
        this.log = [];
        for (const { path, isDirectory, data, load = 0, exec = 0, locked = false } of items)
            this._put(path, { isDirectory, data: data ?? new Uint8Array(0), load, exec, locked });
    }

    _put(path, details) {
        for (let length = 1; length < path.length; length++)
            if (!this.nodes.has(keyOf(path.slice(0, length))))
                this.nodes.set(keyOf(path.slice(0, length)), {
                    name: path[length - 1],
                    isDirectory: true,
                    data: new Uint8Array(0),
                    load: 0,
                    exec: 0,
                    locked: false,
                });
        this.nodes.set(keyOf(path), { name: path.at(-1), ...details });
    }

    /** What is at a path as a test writes it, like "GAMES.ELITE": its name, bytes and information, if anything is. */
    get(dotted) {
        return this.nodes.get(keyOf(dotted.split(".")));
    }

    _describe(node) {
        const { name, isDirectory, data, load, exec, locked } = node;
        return { name, isDirectory, size: isDirectory ? 0 : data.length, load, exec, locked };
    }

    async find(directory, name) {
        await Promise.resolve();
        const node = this.nodes.get(keyOf([...directory, name]));
        return node ? this._describe(node) : null;
    }

    async list(directory) {
        await Promise.resolve();
        if (directory.length > 0 && !this.nodes.get(keyOf(directory))?.isDirectory) return null;
        const entries = [...this.nodes.entries()]
            .filter(([key, node]) => {
                const parent = key.split("\u0000").slice(0, -1);
                return parent.join("\u0000") === keyOf(directory) && node;
            })
            .map(([, node]) => this._describe(node));
        return { entries, skipped: this.skipped };
    }

    async read(path) {
        await Promise.resolve();
        const node = this.nodes.get(keyOf(path));
        if (!node || node.isDirectory) throw new Error(`${path.join(".")} is not a file`);
        return node.data.slice();
    }

    async writeFile(path, { data, load, exec, locked }) {
        await Promise.resolve();
        this.log.push(["writeFile", path.join(".")]);
        this._put(path, { isDirectory: false, data: data.slice(), load, exec, locked });
    }

    async setInfo(path, changes) {
        await Promise.resolve();
        this.log.push(["setInfo", path.join(".")]);
        Object.assign(this.nodes.get(keyOf(path)), changes);
    }

    async makeDirectory(path) {
        await Promise.resolve();
        this.log.push(["makeDirectory", path.join(".")]);
        this._put(path, { isDirectory: true, data: new Uint8Array(0), load: 0, exec: 0, locked: false });
    }

    async remove(path) {
        await Promise.resolve();
        this.log.push(["remove", path.join(".")]);
        this.nodes.delete(keyOf(path));
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

const MaxSettlingTurns = 1000;

/**
 * A host over a store of `items`, on a fake machine, with `call()` to make a call as the ROM does, waiting for it as the
 * ROM does, and a shortcut for each kind of call a test makes.
 */
export function hostWith(items = [], { hasTube = false, store = new MemoryStore(items) } = {}) {
    const cpu = fakeCpu({ hasTube });
    const host = new VdfsHost(cpu, store);

    async function call(number, { a = 0, x = 0, y = 0, p = IdleFlags } = {}) {
        for (const [port, value] of [
            [Port.a, a],
            [Port.x, x],
            [Port.y, y],
            [Port.p, p],
        ])
            host.write(port, value);
        host.write(Port.call, number);
        for (let turn = 0; host.read(Port.call) & Busy; turn++) {
            if (turn === MaxSettlingTurns) throw new Error("the call never finished");
            await new Promise((resolve) => setImmediate(resolve));
        }
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

    return { host, store, cpu, call, osfile, open, command, service, get: (dotted) => store.get(dotted) };
}
