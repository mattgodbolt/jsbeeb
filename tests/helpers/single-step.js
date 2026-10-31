/** Runs one instruction, as the debugger's single step does. */
export function singleStep(cpu) {
    cpu.targetCycles = cpu.currentCycles;
    cpu.execute(1);
}
