import { Call, HostId, Op, Port, VdfsHost } from "../../src/vdfs-host.js";
import { VdfsVolume } from "../../src/vdfs-volume.js";

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

/** A host over a volume of `items`, on a fake machine, with `call()` to make calls as the ROM does. */
export async function hostWith(items = [], { hasTube = false, ...options } = {}) {
    const store = new MemoryStore(items);
    const volume = await VdfsVolume.open(store);
    const cpu = fakeCpu({ hasTube });
    const host = new VdfsHost(cpu, volume, options);
    const registersOf = (stream) => ({ a: stream.a, x: stream.x, y: stream.y, p: stream.p });

    /**
     * Makes a call the way the ROM does, and reads the whole response as it would.
     *
     * @returns {{ops: {op: string, text?: string, number?: number, address?: number}[], a: number, x: number, y: number, p: number}}
     */
    function call(number, { a = 0, x = 0, y = 0, p = 0x30 } = {}) {
        for (const [port, value] of [
            [Port.a, a],
            [Port.x, x],
            [Port.y, y],
            [Port.p, p],
        ])
            host.write(port, value);
        host.write(Port.call, number);
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
                const [x1, y1, p1, a1] = [readByte(), readByte(), readByte(), readByte()];
                return { ops, ...registersOf({ a: a1, x: x1, y: y1, p: p1 }) };
            }
            if (op === Op.print) ops.push({ op: "print", text: readText() });
            else if (op === Op.oscli) ops.push({ op: "oscli", text: readText() });
            else if (op === Op.claim) ops.push({ op: "claim" });
            else if (op === Op.exec) {
                const high = readByte();
                ops.push({ op: "exec", address: ((high << 8) | readByte()) + 1 });
            } else if (op === Op.error) {
                const number = readByte();
                ops.push({ op: "error", number, text: readText() });
                return { ops, a, x, y, p };
            } else throw new Error(`unknown op ${op}`);
        }
    }

    const files = (path) => store.files.get(path);
    return { host, volume, store, cpu, call, files, Call, HostId };
}
