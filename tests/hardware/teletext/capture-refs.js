// Renders each test page under jsbeeb and writes t1.png to t6.png into the
// refs directory beside this script, for comparison against a photograph of
// the same page on real hardware.
//
//   node tests/hardware/teletext/capture-refs.js
//
// The flash phase is not controlled here, so T2 and T6 may be captured in
// either phase; run it again if you want the other one.

import { mkdirSync, writeFileSync } from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MachineSession } from "../../../src/machine-session.js";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
const Disc = path.join(ScriptDir, "teletext-tests.ssd");
const OutputDir = path.join(ScriptDir, "refs");
const Pages = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"];

async function main() {
    mkdirSync(OutputDir, { recursive: true });

    for (const page of Pages) {
        const session = new MachineSession("Master");
        await session.initialise();
        await session.boot();
        session.loadDisc(Disc);
        await session.type(`CHAIN "${page}"`);
        // Each page ends at a GET, so the OS reaching the keyboard is the page being finished.
        await session.runUntilPrompt();
        await session.runFrames(1);
        const file = path.join(OutputDir, `${page.toLowerCase()}.png`);
        writeFileSync(file, await session.screenshotActive());
        session.destroy();
        console.log(`wrote ${file}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
