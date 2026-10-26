// Assembles WebAssembly modules from a flat, one instruction per line form of the text format, so that small
// kernels need no compiler toolchain. Only the instructions the kernels use are known. `;;` starts a comment, as in
// the text format.
//
// The binary format, as far as it is used here (https://webassembly.github.io/spec/core/binary/):
// - The module is the magic "\0asm" and version 1, then sections, each a one byte id, its length in bytes and its
//   contents. They must appear in id order: type (1), import (2), function (3), export (7), code (10).
// - A vector is its element count followed by the elements. Counts, lengths, indices, alignments and offsets are
//   unsigned LEB128: seven bits per byte, least significant first, the top bit set on every byte but the last.
//   i32.const's operand is signed LEB128, which stops once the remaining bits are all copies of the last byte's
//   bit 6, the sign.
// - The type section lists function signatures (0x60, the parameter types, the result types), the function section
//   gives each function its signature by index, and the code section holds the bodies in the same order.
// - A body is its length, its local declarations (runs of count and type, after the parameters, which are the first
//   locals) and its instructions, ending with `end`.
// - An instruction is its opcode, one byte, or 0xfd and an LEB128 sub-opcode for SIMD, then its immediates. A
//   memory access carries log2 of its natural alignment (only a hint) and a constant offset added to the address
//   popped from the stack. A shuffle carries its sixteen lane indices as plain bytes.
// - block, loop and if carry a block type; 0x40 is "takes and leaves nothing". A branch's depth counts enclosing
//   blocks outwards from 0. Branching to a block or if jumps past its end; branching to a loop jumps to its start.

const ValueTypes = { i32: 0x7f, v128: 0x7b };
const EmptyBlockType = 0x40;
const SimdPrefix = 0xfd;
const FunctionType = 0x60;
const MemoryImportKind = 0x02;
const FunctionExportKind = 0x00;
const Section = { type: 1, import: 2, function: 3, export: 7, code: 10 };
const Header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// The immediates each instruction takes: "block" a block type, "local" a local's name, "depth" a branch depth,
// "i32" a constant, "memory" an alignment and offset, "lanes" a shuffle's sixteen lane indices.
const Instructions = {
    block: [[0x02], "block"],
    loop: [[0x03], "block"],
    if: [[0x04], "block"],
    else: [[0x05]],
    end: [[0x0b]],
    br: [[0x0c], "depth"],
    br_if: [[0x0d], "depth"],
    select: [[0x1b]],
    "local.get": [[0x20], "local"],
    "local.set": [[0x21], "local"],
    "local.tee": [[0x22], "local"],
    "i32.load": [[0x28], "memory", 2],
    "i32.load8_u": [[0x2d], "memory", 0],
    "i32.store": [[0x36], "memory", 2],
    "i32.store8": [[0x3a], "memory", 0],
    "i32.const": [[0x41], "i32"],
    "i32.eqz": [[0x45]],
    "i32.eq": [[0x46]],
    "i32.ne": [[0x47]],
    "i32.lt_s": [[0x48]],
    "i32.lt_u": [[0x49]],
    "i32.gt_s": [[0x4a]],
    "i32.gt_u": [[0x4b]],
    "i32.ge_s": [[0x4e]],
    "i32.ge_u": [[0x4f]],
    "i32.add": [[0x6a]],
    "i32.sub": [[0x6b]],
    "i32.mul": [[0x6c]],
    "i32.and": [[0x71]],
    "i32.xor": [[0x73]],
    "i32.shl": [[0x74]],
    "i32.shr_s": [[0x75]],
    "i32.shr_u": [[0x76]],
    "v128.load": [[SimdPrefix, 0x00], "memory", 4],
    "v128.store": [[SimdPrefix, 0x0b], "memory", 4],
    "i8x16.shuffle": [[SimdPrefix, 0x0d], "lanes"],
    "i8x16.swizzle": [[SimdPrefix, 0x0e]],
    "i32x4.splat": [[SimdPrefix, 0x11]],
};

function unsignedLeb(value) {
    const bytes = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value) byte |= 0x80;
        bytes.push(byte);
    } while (value);
    return bytes;
}

function signedLeb(value) {
    const bytes = [];
    for (;;) {
        const byte = value & 0x7f;
        value >>= 7;
        if ((value === 0 && !(byte & 0x40)) || (value === -1 && byte & 0x40)) {
            bytes.push(byte);
            return bytes;
        }
        bytes.push(byte | 0x80);
    }
}

const name = (text) => [...unsignedLeb(text.length), ...Array.from(text, (c) => c.charCodeAt(0))];
const vector = (items) => [...unsignedLeb(items.length), ...items.flat()];
const section = (id, bytes) => [id, ...unsignedLeb(bytes.length), ...bytes];

function immediates(kind, operands, naturalAlignment, localIndex, line) {
    switch (kind) {
        case undefined:
            return [];
        case "block":
            return [EmptyBlockType];
        case "local": {
            const index = localIndex.get(operands[0]);
            if (index === undefined) throw new Error(`Unknown local in "${line}"`);
            return unsignedLeb(index);
        }
        case "depth":
            return unsignedLeb(Number(operands[0]));
        case "i32":
            return signedLeb(Number(operands[0]) | 0);
        case "memory": {
            const offset = operands.find((operand) => operand.startsWith("offset="));
            return [...unsignedLeb(naturalAlignment), ...unsignedLeb(offset ? Number(offset.slice(7)) : 0)];
        }
        case "lanes":
            if (operands.length !== 16) throw new Error(`A shuffle takes sixteen lanes in "${line}"`);
            return operands.map(Number);
    }
    throw new Error(`Unknown immediate kind ${kind}`);
}

function assembleBody(code, localIndex) {
    const bytes = [];
    for (const rawLine of code.split("\n")) {
        const line = rawLine.split(";;")[0].trim();
        if (!line) continue;
        const [mnemonic, ...operands] = line.split(/\s+/);
        const instruction = Instructions[mnemonic];
        if (!instruction) throw new Error(`Unknown instruction in "${line}"`);
        const [opcode, kind, naturalAlignment] = instruction;
        bytes.push(...opcode, ...immediates(kind, operands, naturalAlignment, localIndex, line));
    }
    return bytes;
}

/**
 * @typedef {object} WasmFunction
 * @property {string} name the name it is exported by
 * @property {string[]} params each an i32
 * @property {Record<string, "i32"|"v128">} locals
 * @property {string} code one instruction per line; locals are named, and the body's final `end` is implied
 */

/**
 * A module importing one memory as env.memory and exporting each function, all of which take i32s and return
 * nothing.
 * @param {WasmFunction[]} functions
 * @returns {Uint8Array}
 */
export function assembleModule(functions) {
    const types = functions.map(({ params }) => [FunctionType, ...vector(params.map(() => [ValueTypes.i32])), 0]);
    const bodies = functions.map(({ params, locals, code }) => {
        const localIndex = new Map([...params, ...Object.keys(locals)].map((local, index) => [local, index]));
        const declarations = Object.values(locals).map((type) => [1, ValueTypes[type]]);
        const body = [...vector(declarations), ...assembleBody(code, localIndex), Instructions.end[0][0]];
        return [...unsignedLeb(body.length), ...body];
    });
    const memoryImport = [...name("env"), ...name("memory"), MemoryImportKind, 0x00, ...unsignedLeb(1)];
    return new Uint8Array([
        ...Header,
        ...section(Section.type, vector(types)),
        ...section(Section.import, vector([memoryImport])),
        ...section(Section.function, vector(functions.map((_, index) => unsignedLeb(index)))),
        ...section(
            Section.export,
            vector(functions.map((fn, index) => [...name(fn.name), FunctionExportKind, ...unsignedLeb(index)])),
        ),
        ...section(Section.code, vector(bodies)),
    ]);
}
