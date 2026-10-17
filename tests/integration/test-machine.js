import { describe, expect, it } from "vitest";

import { TestMachine } from "../../src/test-machine.js";
import { mode7Text } from "./helpers.js";

describe("TestMachine", () => {
    const fx19Loop = 'FOR I%=1 TO 5:OSCLI "FX19":NEXT:PRINT "SYN";"CED"';

    it("returns from *FX19", async () => {
        const machine = new TestMachine();
        await machine.initialise();
        await machine.runUntilInput();
        await machine.type(fx19Loop);
        await machine.runUntilInput(5);
        expect(mode7Text(machine)).toContain("SYNCED");
    });

    it("keeps each machine's vsync its own", async () => {
        const machine = new TestMachine();
        await machine.initialise();
        await new TestMachine().initialise();
        await machine.runUntilInput();
        await machine.type(fx19Loop);
        await machine.runUntilInput(5);
        expect(mode7Text(machine)).toContain("SYNCED");
    });

    it("boots a Master with ANFS, which waits for vsync, to a prompt", async () => {
        const machine = new TestMachine("MasterANFS", { econet: true });
        await machine.initialise();
        await machine.runUntilInput(10);
        expect(mode7Text(machine)).toContain("BASIC");
    });
});

describe("TestMachine debug stops", () => {
    const ProgramAddress = 0x2000;
    const LoopAddress = ProgramAddress + 1;
    const LoopWithoutInterrupts = [0x78, 0x4c, LoopAddress & 0xff, LoopAddress >> 8]; // SEI, JMP &2001
    const ReturnAtOnce = [0xa9, 0x01, 0x60]; // LDA #1, RTS
    const JmpCycles = 3;
    const CyclesPerInterlacedFrame = 40000;

    async function bootedMachine() {
        const machine = new TestMachine();
        await machine.initialise();
        await machine.runUntilInput();
        return machine;
    }

    async function stopAt(machine, program, address) {
        const hook = machine.processor.debugInstruction.add((pc) => pc === address);
        program.forEach((byte, i) => machine.writebyte(ProgramAddress + i, byte));
        await machine.type(`CALL &${ProgramAddress.toString(16)}`);
        if (machine.processor.pc !== address) await machine.runFor(40000);
        expect(machine.processor.pc).toBe(address);
        return hook;
    }

    async function cyclesToRun(machine, cycles) {
        const before = machine.elapsedCycles;
        await machine.runFor(cycles);
        return machine.elapsedCycles - before;
    }

    it("does not count the address it is stopped at as reached again", async () => {
        const machine = await bootedMachine();
        (await stopAt(machine, ReturnAtOnce, ProgramAddress)).remove();

        await expect(machine.runUntilAddress(ProgramAddress, 1)).rejects.toThrow("did not hit");
    });

    it("rejects, and leaves no unspent cycles, when a hook throws after the first slice", async () => {
        const machine = await bootedMachine();
        const start = machine.elapsedCycles;
        const hook = machine.processor.debugInstruction.add(() => {
            if (machine.elapsedCycles - start > 150000) throw new Error("hook failed late");
        });

        await expect(machine.runFor(300000)).rejects.toThrow("hook failed late");
        hook.remove();

        expect(await cyclesToRun(machine, 1000)).toBeLessThan(1010);
    });

    it("removes a run-until hook when the run throws", async () => {
        const machine = await bootedMachine();
        const [lo, hi] = [machine.readbyte(0x204), machine.readbyte(0x205)];
        const irqHandler = lo | (hi << 8);
        const failing = machine.processor.debugInstruction.add(() => {
            throw new Error("hook failed");
        });
        await expect(machine.runUntilAddress(irqHandler, 1)).rejects.toThrow("hook failed");
        failing.remove();

        expect(await machine.runFor(CyclesPerInterlacedFrame)).toBe(false);
    });

    it("forgets the hooks called at a stop once the fast path has run", async () => {
        const machine = await bootedMachine();
        const hook = await stopAt(machine, LoopWithoutInterrupts, LoopAddress);
        hook.remove();
        await cyclesToRun(machine, 1000);

        machine.processor.debugInstruction.add(hook);
        const ran = await cyclesToRun(machine, 1000);

        expect(ran).toBe(0);
    });

    it("keeps the hooks called at a stop across an execute that runs nothing", async () => {
        const machine = await bootedMachine();
        await stopAt(machine, LoopWithoutInterrupts, LoopAddress);

        machine.processor.execute(0);
        const ran = await cyclesToRun(machine, 1000);

        expect(ran).toBe(JmpCycles);
    });
});
