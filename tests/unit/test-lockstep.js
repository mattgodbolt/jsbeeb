import { describe, expect, it } from "vitest";

import { RomBankBytes } from "../../src/6502.js";
import { cycleCount, isValidCommit, isValidInput, LockstepGuest, stateHash } from "../../src/lockstep.js";

const RomOffset = 0x10000;

describe("lockstep", () => {
    it.each([
        [{ kind: "key", mapping: [4, 1], down: true }, true],
        [{ kind: "key", mapping: [4, 1, false], down: false }, true],
        [{ kind: "break", down: true }, true],
        [{ kind: "key", mapping: [16, 1], down: true }, false],
        [{ kind: "key", mapping: [4, 1], down: 1 }, false],
        [{ kind: "key", mapping: "x", down: true }, false],
        [{ kind: "poke", address: 0 }, false],
        [null, false],
    ])("takes the input %o from a peer as valid: %s", (input, valid) => {
        expect(isValidInput(input)).toBe(valid);
    });

    it.each([
        [{ at: 5, upTo: 9, inputs: [{ kind: "break", down: false }] }, true],
        [{ at: 5, upTo: 9, inputs: [], hash: "1a" }, true],
        [{ at: 5, upTo: 4, inputs: [] }, false],
        [{ at: 5, upTo: 9 }, false],
        [{ at: 5, upTo: 9, inputs: [{ kind: "poke" }] }, false],
    ])("takes the commit %o from a peer as valid: %s", (commit, valid) => {
        expect(isValidCommit(commit)).toBe(valid);
    });

    it("stops a guest exactly where the host did, an hour in with a fractional target", () => {
        const cyclesPerSecond = 2000000;
        const instructionCycles = 3;
        // Whole instructions until the target is reached, as the CPU runs them.
        const cpu = {
            model: { cyclesPerSecond },
            cycleSeconds: 3600,
            currentCycles: 999,
            targetCycles: 999 + 1 / 3,
            execute(cycles) {
                this.targetCycles += cycles;
                while (this.currentCycles < this.targetCycles) this.currentCycles += instructionCycles;
                return true;
            },
        };
        const desyncs = [];
        const guest = new LockstepGuest(cpu, (reason) => desyncs.push(reason));
        const at = cycleCount(cpu);
        const upTo = at + 100 * instructionCycles;
        guest.receive({ at, inputs: [], upTo });
        guest.execute(upTo - at);
        expect(cycleCount(cpu)).toBe(upTo);
        expect(desyncs).toEqual([]);
    });

    it("fingerprints the registers, the keyboard and sideways RAM as well as RAM, but not ROM", () => {
        const cpu = {
            a: 0,
            x: 0,
            y: 0,
            s: 0,
            pc: 0,
            p: { asByte: () => 0 },
            romOffset: RomOffset,
            ramRomOs: new Uint8Array(RomOffset + 2 * RomBankBytes),
            model: { swram: [false, true] },
            sysvia: { keys: [new Uint8Array(8)] },
        };
        const unchanged = stateHash(cpu);
        const changes = [
            () => (cpu.x ^= 1),
            () => (cpu.sysvia.keys[0][3] ^= 1),
            () => (cpu.ramRomOs[0x3000] ^= 1),
            () => (cpu.ramRomOs[RomOffset + RomBankBytes] ^= 1),
        ];
        for (const change of changes) {
            change();
            expect(stateHash(cpu)).not.toBe(unchanged);
            change();
            expect(stateHash(cpu)).toBe(unchanged);
        }
        cpu.ramRomOs[RomOffset] ^= 1;
        expect(stateHash(cpu)).toBe(unchanged);
    });
});
