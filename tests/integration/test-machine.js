import { describe, expect, it } from "vitest";

import { MaxCyclesPerIter, TestMachine } from "../../src/test-machine.js";
import { mode7Text } from "./helpers.js";

describe("TestMachine", () => {
    const fx19Loop = 'FOR I%=1 TO 5:OSCLI "FX19":NEXT:PRINT "SYN";"CED"';

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

    it.each(["bogus", "constructor"])("refuses a breakpoint of type %s", (type) => {
        expect(() => new TestMachine().addBreakpoint(type, 0, {}, () => {})).toThrow(
            `Unknown breakpoint type: ${type}`,
        );
    });

    const hex = (value) => value.toString(16).toUpperCase();
    for (const [model, romsel, address, bank, paged] of [
        ["Master", 0x04, 0x8000, 4, true],
        ["Master", 0x04, 0x9000, 5, false],
        ["Master", 0x84, 0x8000, 4, false],
        ["Master", 0x84, 0x8fff, 4, false],
        ["Master", 0x84, 0x9000, 4, true],
        ["B-DFS1.2", 0x84, 0x8000, 4, true],
        ["B-stock", 0x00, 0x8000, 12, true],
        ["B-stock", 0x08, 0x8000, 12, true],
        ["B-stock", 0x00, 0x8000, 0, false],
    ]) {
        it(`on a ${model} with ROMSEL &${hex(romsel)}, bank ${bank} is ${paged ? "" : "not "}paged at &${hex(address)}`, () => {
            const machine = new TestMachine(model);
            machine.processor.romSelect(romsel);

            expect(machine.isBankPagedAt(bank, address)).toBe(paged);
        });
    }
});

describe("TestMachine debug stops", () => {
    const ProgramAddress = 0x2000;
    const LoopAddress = ProgramAddress + 1;
    const LoopWithoutInterrupts = [0x78, 0x4c, LoopAddress & 0xff, LoopAddress >> 8]; // SEI, JMP &2001
    const ReturnAtOnce = [0xa9, 0x01, 0x60]; // LDA #1, RTS
    const JmpCycles = 3;
    const CyclesPerInterlacedFrame = 40000;
    const ShortRunCycles = 1000;
    // The most cycles a run can overrun its target by: the instruction that crosses it.
    const MaxOverrunCycles = 10;
    const IrqVector = 0x204;

    async function bootedMachine() {
        const machine = new TestMachine();
        await machine.initialise();
        await machine.runUntilInput();
        return machine;
    }

    function writeBytes(machine, address, bytes) {
        bytes.forEach((byte, i) => machine.writebyte(address + i, byte));
    }

    async function stopAt(machine, program, address) {
        const hook = machine.processor.debugInstruction.add((pc) => pc === address);
        writeBytes(machine, ProgramAddress, program);
        await machine.type(`CALL &${ProgramAddress.toString(16)}`);
        if (machine.processor.pc !== address) await machine.runFor(CyclesPerInterlacedFrame);
        expect(machine.processor.pc).toBe(address);
        return hook;
    }

    async function cyclesToRun(machine, cycles) {
        const before = machine.elapsedCycles;
        await machine.runFor(cycles);
        return machine.elapsedCycles - before;
    }

    it("started at its own address, runUntilAddress waits for the next visit", async () => {
        const machine = await bootedMachine();
        (await stopAt(machine, ReturnAtOnce, ProgramAddress)).remove();

        await expect(machine.runUntilAddress(ProgramAddress, 1)).rejects.toThrow("did not hit");
    });

    it("runUntilAddress removes its hook when the run throws", async () => {
        const machine = await bootedMachine();
        const irqHandler = machine.readbyte(IrqVector) | (machine.readbyte(IrqVector + 1) << 8);
        const failing = machine.processor.debugInstruction.add(() => {
            throw new Error("hook failed");
        });
        await expect(machine.runUntilAddress(irqHandler, 1)).rejects.toThrow("hook failed");
        failing.remove();

        expect(await machine.runFor(2 * CyclesPerInterlacedFrame)).toBe(false);
    });

    it("rejects, and leaves no unspent cycles, when a hook throws after the first slice", async () => {
        const machine = await bootedMachine();
        const start = machine.elapsedCycles;
        const hook = machine.processor.debugInstruction.add(() => {
            if (machine.elapsedCycles - start > MaxCyclesPerIter * 1.5) throw new Error("hook failed late");
        });

        await expect(machine.runFor(MaxCyclesPerIter * 3)).rejects.toThrow("hook failed late");
        hook.remove();

        expect(await cyclesToRun(machine, ShortRunCycles)).toBeLessThan(ShortRunCycles + MaxOverrunCycles);
    });

    describe("a hook called at a stop, removed and added back", () => {
        it("stops again once the fast path has run", async () => {
            const machine = await bootedMachine();
            const hook = await stopAt(machine, LoopWithoutInterrupts, LoopAddress);
            hook.remove();
            await cyclesToRun(machine, ShortRunCycles);

            machine.processor.debugInstruction.add(hook);

            expect(await cyclesToRun(machine, ShortRunCycles)).toBe(0);
        });

        it("does not stop again when the fast path ran nothing", async () => {
            const machine = await bootedMachine();
            const hook = await stopAt(machine, LoopWithoutInterrupts, LoopAddress);
            hook.remove();
            machine.processor.execute(0);

            machine.processor.debugInstruction.add(hook);

            expect(await cyclesToRun(machine, ShortRunCycles)).toBe(JmpCycles);
        });
    });

    describe("a state saved where a hook stopped it", () => {
        it("says so, where one saved running does not", async () => {
            const machine = await bootedMachine();
            expect(machine.snapshot().stoppedAtBreakpoint).toBe(false);

            await stopAt(machine, LoopWithoutInterrupts, LoopAddress);

            expect(machine.snapshot().stoppedAtBreakpoint).toBe(true);
        });

        it("runs on past the restored pc, which a hook added since still sees", async () => {
            const machine = await bootedMachine();
            const hook = await stopAt(machine, LoopWithoutInterrupts, LoopAddress);
            const state = machine.snapshot();
            hook.remove();
            await cyclesToRun(machine, ShortRunCycles);
            machine.processor.debugInstruction.add(hook);
            const pcs = [];
            machine.processor.debugInstruction.add((pc) => {
                pcs.push(pc);
            });

            machine.restore(state);

            expect(await cyclesToRun(machine, ShortRunCycles)).toBe(JmpCycles);
            expect(pcs).toEqual([LoopAddress, LoopAddress]);
        });

        it("stops at the restored pc when the state predates the field", async () => {
            const machine = await bootedMachine();
            await stopAt(machine, LoopWithoutInterrupts, LoopAddress);
            const state = machine.snapshot();
            delete state.stoppedAtBreakpoint;

            machine.restore(state);

            expect(await cyclesToRun(machine, ShortRunCycles)).toBe(0);
        });
    });

    it("keeps the hooks called at a stop across an execute that runs nothing", async () => {
        const machine = await bootedMachine();
        await stopAt(machine, LoopWithoutInterrupts, LoopAddress);

        machine.processor.execute(0);

        expect(await cyclesToRun(machine, ShortRunCycles)).toBe(JmpCycles);
    });
});
