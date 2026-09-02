"use strict";

const SidewaysStart = 0x8000;
const SidewaysEnd = 0xc000;
const SidewaysSize = SidewaysEnd - SidewaysStart;
const NumBanks = 16;

/**
 * Records which addresses the CPU has fetched opcodes from. Each entry holds
 * the opcode byte plus one (zero means never executed), so an entry vouches
 * for itself: it is trustworthy exactly when the byte in memory still matches,
 * which covers self-modifying code and overwritten RAM with no write hook.
 * The sideways region is keyed by ROM bank as each bank has its own code at
 * the same addresses; Master shadow and private RAM alias that keying, and
 * the opcode check catches nearly all of it.
 */
export class ExecutionMap {
    constructor(cpu) {
        this._cpu = cpu;
        this._main = new Uint16Array(0x10000);
        this._sideways = new Array(NumBanks).fill(null);
    }

    record(addr, opcode) {
        addr &= 0xffff;
        if (addr >= SidewaysStart && addr < SidewaysEnd) {
            const bank = this._cpu.romsel & 15;
            let entries = this._sideways[bank];
            if (!entries) entries = this._sideways[bank] = new Uint16Array(SidewaysSize);
            entries[addr - SidewaysStart] = opcode + 1;
        } else {
            this._main[addr] = opcode + 1;
        }
    }

    /** True when the instruction at addr was executed and its opcode byte is unchanged. */
    isVerified(addr) {
        addr &= 0xffff;
        let entry;
        if (addr >= SidewaysStart && addr < SidewaysEnd) {
            const entries = this._sideways[this._cpu.romsel & 15];
            if (!entries) return false;
            entry = entries[addr - SidewaysStart];
        } else {
            entry = this._main[addr];
        }
        return entry !== 0 && entry === this._cpu.peekmem(addr) + 1;
    }
}
