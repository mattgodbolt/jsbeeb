import { describe, expect, it } from "vitest";

import { benchmarkMachine, listBenchmarkWorkloads, newBenchmarkMachine } from "../../src/benchmark-machine.js";
import { readWorkload, restoreWorkload } from "../../src/benchmark-workloads.js";

const workloads = await listBenchmarkWorkloads();
const OsRomResetVector = 0xfffc;

async function restoreAltered(name, alter) {
    const workload = await readWorkload(name);
    const machine = await newBenchmarkMachine(workload.model);
    alter(workload, machine);
    return restoreWorkload(machine.processor, workload);
}

describe("benchmark workloads", () => {
    describe.each(workloads.map(({ name }) => name))("%s", (name) => {
        it.each([false, true])("restores, checks and runs on the fast path with fakeVideo %s", async (fakeVideo) => {
            const { cpu, workload } = await benchmarkMachine(name, { fakeVideo });
            expect(cpu.onFastPath).toBe(true);
            expect(cpu.pc).toBe(workload.snapshot.state.pc);
            expect(cpu.currentCycles).toBe(workload.snapshot.state.currentCycles);
        });
    });

    it("puts back the disc a workload was made with, and empties a drive it had none in", async () => {
        const { cpu } = await benchmarkMachine("elite");
        expect(cpu.fdc.drives[0].disc.name).toBe("elite.ssd");
        await restoreWorkload(cpu, await readWorkload("mode7-text"));
        expect(cpu.fdc.drives[0].disc).toBeFalsy();
    });

    it("names the workloads there are when asked for one there is not", async () => {
        await expect(readWorkload("no-such-workload")).rejects.toThrow(
            /No benchmark workload "no-such-workload".*elite/,
        );
    });

    it("fails a workload whose machine is not in the state its name says", async () => {
        const restoring = restoreAltered("mode7-text", (workload) => {
            workload.checks.bytes[0].value = 0;
        });
        await expect(restoring).rejects.toThrow(
            /not what it says: the OS screen mode, MODE 7 at &355 reads &7, not &0/,
        );
    });

    it("fails a workload whose program does not move", async () => {
        const restoring = restoreAltered("elite", (workload) => {
            workload.checks.advancing = { address: OsRomResetVector, length: 2, what: "the reset vector" };
        });
        await expect(restoring).rejects.toThrow(/"elite" is not running: the reset vector at &FFFC did not change/);
    });

    it("refuses a machine that would leave the fast path", async () => {
        const restoring = restoreAltered("elite", (workload, machine) => {
            machine.processor.debugInstruction.add(() => false);
        });
        await expect(restoring).rejects.toThrow(/would run the slow executeInternal/);
    });
});
