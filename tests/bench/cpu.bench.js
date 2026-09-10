import { test } from "vitest";

import { discFor, load } from "../../src/fdc.js";
import { fake6502 } from "../../src/fake6502.js";
import { keyCodes } from "../../src/keymap.js";
import { findModel } from "../../src/models.js";

// An iteration runs a million cycles, so the hz column Vitest prints reads as virtual MHz.
const CyclesPerIteration = 1000 * 1000;
const CyclesToBoot = 10 * 1000 * 1000;
const EliteImage = "elite.ssd";

async function eliteUnderway() {
    const cpu = fake6502(findModel("B"));
    await cpu.initialise();
    cpu.fdc.loadDisc(0, discFor(EliteImage, await load(`discs/${EliteImage}`)));
    cpu.sysvia.keyDown(keyCodes.SHIFT);
    cpu.execute(CyclesToBoot);
    cpu.sysvia.keyUp(keyCodes.SHIFT);
    return cpu;
}

test("a model B with Elite underway", async ({ bench }) => {
    const cpu = await eliteUnderway();
    await bench("6502 and its hardware", () => cpu.execute(CyclesPerIteration)).run();
});
