/** Longest, in bytes, a loop can be and still count as tight. */
const MaxLoopBytes = 32;

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
function waitingInstruction(disassembler, address) {
    const peek = (at) => disassembler.cpu.peekmem(at & 0xffff);
    const [mnemonic, mode] = (disassembler.opcodes[peek(address)] ?? "").split(" ");
    const [, end, operand] = disassembler.disassemble(address, true);
    if (end > 0xffff) return undefined;
    const next = end;
    const step = (target, reads, unconditional) => ({ next, target, reads, unconditional });
    if (mode === "branch") return step(operand, [], mnemonic === "BRA");
    if (mnemonic === "JMP" && mode === "abs") return step(operand, [], true);
    if (Quiet.has(mnemonic)) return step(undefined, [], false);
    if (!Reading.has(mnemonic)) return undefined;
    if (mode === "imm") return step(undefined, [], false);
    if (mode === "zp") return step(undefined, [peek(address + 1)], false);
    if (mode === "abs") return step(undefined, [operand], false);
    return undefined;
}

/**
 * The tight loop the instruction at `pc` is part of, if it is in one: a short run of instructions closed by a branch
 * back that writes nothing, calls nothing and only loads its registers, so that it waits for what it reads to be
 * changed by a device or an interrupt. Found from the code alone, without running it.
 * @param {{cpu: {peekmem: (address: number) => number}, opcodes: Object<number, string>,
 * disassemble: (address: number, plain: boolean) => any[]}} disassembler the CPU's
 * @param {number} pc
 * @returns {TightLoop | undefined}
 */
export function tightLoopAt(disassembler, pc) {
    for (let address = pc; address - pc < MaxLoopBytes;) {
        const instruction = waitingInstruction(disassembler, address);
        if (!instruction) return undefined;
        const { target } = instruction;
        if (target !== undefined && target <= pc && address - target < MaxLoopBytes)
            return loopFrom(disassembler, target, address, pc);
        if (instruction.unconditional) return undefined;
        address = instruction.next;
    }
    return undefined;
}

/** The loop from `start` to the branch back at `end`, if every instruction of it on the way through `pc` waits. */
function loopFrom(disassembler, start, end, pc) {
    const reads = new Set();
    let passesPc = false;
    for (let address = start; address <= end;) {
        const instruction = waitingInstruction(disassembler, address);
        if (!instruction) return undefined;
        passesPc ||= address === pc;
        for (const read of instruction.reads) reads.add(read);
        if (address === end) return passesPc ? { start, end, reads: [...reads] } : undefined;
        address = instruction.next;
    }
    return undefined;
}
