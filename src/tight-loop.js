import { signExtend } from "./binary.js";

/** Longest, in bytes, a loop can be and still count as tight. */
const MaxLoopBytes = 32;

const ModeBytes = {
    "": 1,
    A: 1,
    imm: 2,
    zp: 2,
    "zp,x": 2,
    "zp,y": 2,
    "(,x)": 2,
    "(),y": 2,
    "()": 2,
    branch: 2,
    "zp,branch": 3,
    abs: 3,
    "abs,x": 3,
    "abs,y": 3,
    "(abs)": 3,
    "(abs,x)": 3,
};

const Reading = new Set(["LDA", "LDX", "LDY", "BIT", "CMP", "CPX", "CPY", "AND", "ORA"]);
const Quiet = new Set(["TAX", "TAY", "TXA", "TYA", "TSX", "CLC", "SEC", "CLI", "SEI", "CLV", "CLD", "SED", "NOP"]);

/**
 * @typedef {object} TightLoop
 * @property {number} start the address of its first instruction
 * @property {number} end the address of the branch back to `start`
 * @property {number[]} reads the addresses it reads, each once, in the order it first reads them
 */

/**
 * The instruction at `address`, as far as a tight loop cares: where it goes next, where it may branch, and what it
 * reads. Undefined for one no tight loop runs: a write, a call, a return, an indexed or indirect read, an unknown
 * opcode, or anything that changes a register other than by loading it.
 */
function waitingInstruction(opcodes, peek, address) {
    const [mnemonic, mode = ""] = (opcodes[peek(address)] ?? "").split(" ");
    const next = address + ModeBytes[mode];
    const byte = (offset) => peek((address + offset) & 0xffff);
    if (mode === "branch") {
        const target = (next + signExtend(byte(1))) & 0xffff;
        return { next, target, reads: [], unconditional: mnemonic === "BRA" };
    }
    if (mode === "zp,branch") {
        const target = (next + signExtend(byte(2))) & 0xffff;
        return { next, target, reads: [byte(1)], unconditional: false };
    }
    if (mnemonic === "JMP" && mode === "abs") {
        return { next, target: byte(1) | (byte(2) << 8), reads: [], unconditional: true };
    }
    if (Quiet.has(mnemonic)) return { next, target: undefined, reads: [], unconditional: false };
    if (!Reading.has(mnemonic)) return undefined;
    if (mode === "imm") return { next, target: undefined, reads: [], unconditional: false };
    if (mode === "zp") return { next, target: undefined, reads: [byte(1)], unconditional: false };
    if (mode === "abs") return { next, target: undefined, reads: [byte(1) | (byte(2) << 8)], unconditional: false };
    return undefined;
}

/**
 * The tight loop the instruction at `pc` is part of, if it is in one: a short run of instructions closed by a branch
 * back that writes nothing, calls nothing and only loads its registers, so that it waits for what it reads to be
 * changed by a device or an interrupt. Found from the code alone, without running it.
 * @param {Object<number, string>} opcodes the CPU's opcode table, as its disassembler has it
 * @param {(address: number) => number} peek reads memory without side effects
 * @param {number} pc
 * @returns {TightLoop | undefined}
 */
export function tightLoopAt(opcodes, peek, pc) {
    for (let address = pc; address - pc < MaxLoopBytes;) {
        const instruction = waitingInstruction(opcodes, peek, address);
        if (!instruction) return undefined;
        const { target } = instruction;
        if (target !== undefined && target <= pc && address - target < MaxLoopBytes)
            return loopFrom(opcodes, peek, target, address, pc);
        if (instruction.unconditional) return undefined;
        address = instruction.next;
    }
    return undefined;
}

/** The loop from `start` to the branch back at `end`, if every instruction of it on the way through `pc` waits. */
function loopFrom(opcodes, peek, start, end, pc) {
    const reads = new Set();
    let passesPc = false;
    for (let address = start; address <= end;) {
        const instruction = waitingInstruction(opcodes, peek, address);
        if (!instruction) return undefined;
        passesPc ||= address === pc;
        for (const read of instruction.reads) reads.add(read);
        if (address === end) return passesPc ? { start, end, reads: [...reads] } : undefined;
        address = instruction.next;
    }
    return undefined;
}
