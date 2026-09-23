// Runs the interlace restart disc under jsbeeb and prints the table it leaves on
// its MODE 7 screen, the same one a real machine shows.
//
//   node tests/hardware/crtc-interlace/run.js [model]
//   node tests/hardware/crtc-interlace/run.js --screen <dump>
//
// The model defaults to B-DFS1.2. --screen decodes a 1K dump of &7C00 saved
// from another emulator instead; README.md has the beebjit command.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MachineSession } from "../../../src/machine-session.js";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
const Disc = path.join(ScriptDir, "interlace-restarts.ssd");
const Mode7Screen = 0x7c00;
const Mode7Cols = 40;
const Mode7Rows = 25;
const DoneMarker = 0xfcd0;
const TimeoutSecs = 60;

function screenText(bytes) {
    const rows = [];
    for (let row = 0; row < Mode7Rows; row++) {
        const line = Array.from(bytes.slice(row * Mode7Cols, (row + 1) * Mode7Cols), (b) => {
            const c = b & 0x7f;
            return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ";
        });
        rows.push(line.join("").trimEnd());
    }
    return rows.filter((row) => row).join("\n");
}

async function runInJsbeeb(model) {
    const session = new MachineSession(model, { discImage: Disc });
    await session.initialise();
    await session.boot();
    await session.type('CHAIN "TEST"');
    session.addBreakpoint("write", DoneMarker);
    await session.runFor(TimeoutSecs * 2 * 1000 * 1000);
    if (!session.hitBreakpoint()) throw new Error(`the test did not finish within ${TimeoutSecs}s of emulated time`);
    return session.readMemory(Mode7Screen, Mode7Cols * Mode7Rows);
}

async function main() {
    const [first, second] = process.argv.slice(2);
    const bytes = first === "--screen" ? readFileSync(second) : await runInJsbeeb(first ?? "B-DFS1.2");
    console.log(screenText(bytes));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
