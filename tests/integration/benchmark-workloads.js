import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { benchmarkMachine, listBenchmarkWorkloads, newBenchmarkMachine } from "../../src/benchmark-machine.js";
import { readWorkload, restoreWorkload } from "../../src/benchmark-workloads.js";
import { RepoRoot } from "../../src/test-machine.js";
import { workloadHashes } from "../../tools/same-answer.js";
import { checkDrainsAgainstJs } from "../helpers/compare-drains.js";

const workloads = await listBenchmarkWorkloads();
const RecordedHashes = JSON.parse(readFileSync(path.join(RepoRoot, "tests", "same-answer-hashes.json"), "utf8"));
const OsRomResetVector = 0xfffc;
const CheckedFrames = 100;
const FramesPerSecond = 50;
const FittedOn = {
    coProcessor: (cpu) => cpu.hasTube,
    hasMusic5000: (cpu) => cpu.hasMusic5000,
    hasTeletextAdaptor: (cpu) => cpu.hasTeletextAdaptor,
    hasEconet: (cpu) => !!cpu.econet,
    hasVideoNula: (cpu) => cpu.video.ula.hasVideoNula,
};

async function restoreAltered(name, alter) {
    const workload = await readWorkload(name);
    const machine = await newBenchmarkMachine(workload.model, workload.fittings);
    alter(workload);
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

        it("draws every pending cell as the JS drain does", async () => {
            const { cpu } = await benchmarkMachine(name);
            const checked = checkDrainsAgainstJs(cpu.video.drain);
            for (let frame = 0; frame < CheckedFrames; ++frame)
                cpu.execute(cpu.model.cyclesPerSecond / FramesPerSecond);
            expect(checked.differences).toEqual([]);
            if (name === "mode7-text") expect(checked.teletextPaints).toBeGreaterThan(0);
        });

        it("ends in the state test:same-answer recorded when drawn by the JS drain", async () => {
            expect(await workloadHashes(name, "js")).toEqual(RecordedHashes.workloads[name]);
        });
    });

    it.each(Object.keys(workloads[0].fittings))("builds a machine with %s fitted and nothing else", async (fitted) => {
        const fittings = Object.fromEntries(Object.keys(workloads[0].fittings).map((name) => [name, name === fitted]));
        const { processor } = await newBenchmarkMachine("B-DFS1.2", fittings);
        const found = Object.fromEntries(Object.keys(fittings).map((name) => [name, FittedOn[name](processor)]));
        expect(found).toEqual(fittings);
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

    it("refuses a disc that is not the one the workload was made with before touching the drives", async () => {
        const { cpu, workload } = await benchmarkMachine("elite");
        const disc = cpu.fdc.drives[0].disc;
        workload.snapshot.media.disc1Crc32 += 1;
        await expect(restoreWorkload(cpu, workload)).rejects.toThrow(
            /discs\/elite.ssd is not the disc the workload was made with/,
        );
        expect(cpu.fdc.drives[0].disc).toBe(disc);
    });

    it("refuses a machine of another model before touching its drives", async () => {
        const { cpu } = await benchmarkMachine("master-shadow");
        const disc = cpu.fdc.drives[0].disc;
        await expect(restoreWorkload(cpu, await readWorkload("elite"))).rejects.toThrow(/Model mismatch/);
        expect(cpu.fdc.drives[0].disc).toBe(disc);
    });

    it("refuses a machine that would leave the fast path before touching it", async () => {
        const { cpu } = await benchmarkMachine("mode7-text");
        const pc = cpu.pc;
        cpu.debugInstruction.add(() => false);
        await expect(restoreWorkload(cpu, await readWorkload("elite"))).rejects.toThrow(
            /would run the slow executeInternal/,
        );
        expect(cpu.pc).toBe(pc);
        expect(cpu.fdc.drives[0].disc).toBeFalsy();
    });
});
