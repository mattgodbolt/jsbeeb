import path from "node:path";
import { fileURLToPath } from "node:url";
import { MachineSession } from "../../../src/machine-session.js";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
export const Disc = path.join(ScriptDir, "teletext-tests.ssd");
export const RefDir = path.join(ScriptDir, "refs");
export const Pages = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"];

// T8 runs a raster loop with interrupts off until a key is pressed, so there is no prompt to
// wait for; its BASIC setup is done well inside this.
const RasterPageFrames = 200;

/** Renders one page of the test disc under jsbeeb and returns a PNG of the active display. */
export async function renderPage(page) {
    const session = new MachineSession("Master");
    try {
        await session.initialise();
        await session.boot();
        session.loadDisc(Disc);
        await session.type(`CHAIN "${page}"`);
        if (page === "T8") {
            await session.runFrames(RasterPageFrames);
        } else {
            // Each page ends at a GET, so the OS reaching the keyboard is the page having
            // finished drawing. This keeps the flash phase reproducible too.
            await session.runUntilPrompt();
            await session.runFrames(1);
        }
        return await session.screenshotActive();
    } finally {
        session.destroy();
    }
}
