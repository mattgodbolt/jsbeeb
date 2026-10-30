/** Furthest, in bytes, a tight loop's branch back can be from the instruction it goes back to. */
const MaxLoopBytes = 32;

const DirectModes = new Set(["implied", "imm", "zp", "abs", "branch", "zp,branch"]);

/**
 * @typedef {object} TightLoop
 * @property {number} start the address of its first instruction
 * @property {number} end the address of the branch back to `start`
 * @property {number[]} reads the addresses it reads, each once, in the order it first reads them
 */

/**
 * The instruction at `address`, as far as a tight loop cares: where it goes next, where it may branch, and what it
 * reads. Undefined for one no tight loop runs: a write, a call, a return, an indexed or indirect operand, or one
 * that would change something more if run again at once.
 * @param {import("./6502.opcodes.js").Disassemble6502} disassembler
 */
function waitingInstruction(disassembler, address) {
    const { mnemonic, mode, accesses, flow, next, address: operand, target } = disassembler.instructionAt(address);
    if (next > 0xffff || accesses.includes("write")) return undefined;
    if (flow === "jump" && mode === "abs") return { next, target, reads: [], unconditional: true };
    if (!(flow === "next" || flow === "branch") || !DirectModes.has(mode)) return undefined;
    if (!disassembler.isIdempotent(disassembler.cpu.peekmem(address))) return undefined;
    const reads = accesses.includes("read") ? [operand] : [];
    return { next, target, reads, unconditional: mnemonic === "BRA" };
}

/**
 * The tight loop the instruction at `pc` is part of, if it is in one: a short run of instructions closed by a branch
 * back, each of which writes nothing, calls nothing and settles, changing nothing more when run again at once, so
 * that the loop waits for what it reads to be changed by a device or an interrupt. Found from the code alone.
 * @param {import("./6502.opcodes.js").Disassemble6502} disassembler the CPU's
 * @param {number} pc
 * @returns {TightLoop | undefined}
 */
export function tightLoopAt(disassembler, pc) {
    for (let address = pc; address - pc <= MaxLoopBytes;) {
        const instruction = waitingInstruction(disassembler, address);
        if (!instruction) return undefined;
        const { target } = instruction;
        if (target !== undefined && target <= pc && address - target <= MaxLoopBytes)
            return loopFrom(disassembler, target, address, pc);
        if (instruction.unconditional) return undefined;
        address = instruction.next;
    }
    return undefined;
}

/**
 * The loop from `start` to the branch back at `end`, if every instruction of it on the way through `pc` waits and
 * none jumps away before `end`.
 */
function loopFrom(disassembler, start, end, pc) {
    const reads = new Set();
    let passesPc = false;
    for (let address = start; address <= end;) {
        const instruction = waitingInstruction(disassembler, address);
        if (!instruction) return undefined;
        passesPc ||= address === pc;
        for (const read of instruction.reads) reads.add(read);
        if (address === end) return passesPc ? { start, end, reads: [...reads] } : undefined;
        if (instruction.unconditional) return undefined;
        address = instruction.next;
    }
    return undefined;
}
