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

const FieldCycles = 40000;
const FlashCycleFields = 64;
// The OS blanks flashing text for fields 27 to 42 of every 64 it has counted since power-on.
// T6's reference shows the flashing band blanked; the other pages were taken with it shown.
const FlashShownField = 10;
const FlashBlankedField = 35;
const CaptureField = { T6: FlashBlankedField };

async function runToField(session, field) {
    while (Math.floor(session.elapsedCycles / FieldCycles) % FlashCycleFields !== field) {
        await session.runFrames(1);
    }
}

// Where T8's boxes sit follows from where in the frame its raster loop caught vsync, which
// follows from when the program started. Only the widths are the measurement, but the
// reference pins a position, so start the page from where the reference started it:
// three frames and 12000 cycles after the prompt.
const T8StartFramesAfterPrompt = 3;
const T8StartCyclesIntoFrame = 12000;

/** Renders one page of the test disc under jsbeeb and returns a PNG of the active display. */
export async function renderPage(page) {
    const session = new MachineSession("Master");
    try {
        await session.initialise();
        await session.boot();
        session.loadDisc(Disc);
        if (page === "T8") {
            await session.runFrames(T8StartFramesAfterPrompt);
            await session.runFor(T8StartCyclesIntoFrame);
        }
        await session.type(`CHAIN "${page}"`);
        if (page === "T8") {
            await session.runFrames(RasterPageFrames);
        } else {
            // Each page ends at a GET, so the OS reaching the keyboard is the page having
            // finished drawing.
            await session.runUntilPrompt();
            await runToField(session, CaptureField[page] ?? FlashShownField);
        }
        return await session.screenshotActive();
    } finally {
        session.destroy();
    }
}
