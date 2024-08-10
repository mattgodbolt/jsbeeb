"use strict";

import { fake6502 } from "./fake6502.js";
import * as models from "./models.js";
import * as disc from "./fdc.js";

function benchmarkCpu(cpu, numCyclesPerRep, numTimes) {
    console.log(`Benchmarking over ${numCyclesPerRep / 1000000}M cpu cycles, ${numTimes} times`);
    for (let time = 0; time < numTimes; ++time) {
        const startTime = Date.now();
        cpu.execute(numCyclesPerRep);
        const endTime = Date.now();
        const msTaken = endTime - startTime;
        const virtualMhz = numCyclesPerRep / msTaken / 1000;
        console.log(
            `${time}: Took ${msTaken}ms to execute ${numCyclesPerRep / 1000000}M cycles; Virtual ${virtualMhz.toFixed(2)}MHz`,
        );
    }
}

async function main() {
    const discName = "elite";
    const cpu = fake6502(models.findModel("B"));
    await cpu.initialise();
    const data = await disc.load("discs/" + discName + ".ssd");
    cpu.fdc.loadDisc(0, disc.discFor(cpu.fdc, discName, data));
    cpu.sysvia.keyDown(16);
    cpu.execute(10 * 1000 * 1000);
    cpu.sysvia.keyUp(16);
    benchmarkCpu(cpu, 100 * 1000 * 1000, 10);
}

main().then(() => {});
