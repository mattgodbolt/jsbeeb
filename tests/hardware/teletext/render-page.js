import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
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

// T8's loop polls for vsync every 8 cycles, so where its boxes land depends on when it started,
// to one of four cell positions, and that depends on disc timing. The reference has the first
// box at this column; try start points until one puts it there.
const T8FirstBoxColumn = 9.5;
const T8StartStepCycles = 1000;
const T8MaxStarts = 32;
const ScreenColumns = 40;

const isRed = (data, i) => data[i] > 128 && data[i + 1] < 128 && data[i + 2] < 128;

async function firstBoxColumn(png) {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const rowStart = Math.floor(info.height / 2) * info.width;
    const redAt = (x) => isRed(data, (rowStart + x) * info.channels);
    let fieldStart = 0;
    while (fieldStart < info.width && !redAt(fieldStart)) fieldStart++;
    let fieldEnd = info.width;
    while (fieldEnd > fieldStart && !redAt(fieldEnd - 1)) fieldEnd--;
    let boxStart = fieldStart;
    while (boxStart < fieldEnd && redAt(boxStart)) boxStart++;
    return ((boxStart - fieldStart) * ScreenColumns) / (fieldEnd - fieldStart);
}

async function startSession() {
    const session = new MachineSession("Master");
    await session.initialise();
    await session.boot();
    session.loadDisc(Disc);
    return session;
}

async function renderT8() {
    for (let start = 0; start < T8MaxStarts; start++) {
        const session = await startSession();
        try {
            await session.runFor(start * T8StartStepCycles);
            await session.type(`CHAIN "T8"`);
            await session.runFrames(RasterPageFrames);
            const png = await session.screenshotActive();
            if ((await firstBoxColumn(png)) === T8FirstBoxColumn) return png;
        } finally {
            session.destroy();
        }
    }
    throw new Error(`T8 never put its first box at column ${T8FirstBoxColumn} in ${T8MaxStarts} start points`);
}

/** Renders one page of the test disc under jsbeeb and returns a PNG of the active display. */
export async function renderPage(page) {
    if (page === "T8") return renderT8();
    const session = await startSession();
    try {
        await session.type(`CHAIN "${page}"`);
        // Each page ends at a GET, so the OS reaching the keyboard is the page having
        // finished drawing.
        await session.runUntilPrompt();
        await runToField(session, CaptureField[page] ?? FlashShownField);
        return await session.screenshotActive();
    } finally {
        session.destroy();
    }
}
