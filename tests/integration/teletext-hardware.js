import { describe, it } from "vitest";
import assert from "assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pixelmatch from "pixelmatch";
import { MachineSession } from "../../src/machine-session.js";

// The reference images were photographed against a real BBC Master 128 running
// MOS 3.20 and agreed with it on every page, so they pin behaviour we have
// measured rather than behaviour we have merely chosen. See
// tests/hardware/teletext/README.md for what each page tests.
const HardwareDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../hardware/teletext");
const Disc = path.join(HardwareDir, "teletext-tests.ssd");
const RefDir = path.join(HardwareDir, "refs");
const OutputDir = "tests/integration/output";
const Pages = ["T1", "T2", "T3", "T4", "T5", "T6"];

async function renderPage(page) {
    const session = new MachineSession("Master");
    try {
        await session.initialise();
        await session.boot();
        session.loadDisc(Disc);
        await session.type(`CHAIN "${page}"`);
        // Each page ends at a GET, so the OS reaching the keyboard is the page having
        // finished drawing. This keeps the flash phase reproducible too.
        await session.runUntilPrompt();
        await session.runFrames(1);
        return await session.screenshotActive();
    } finally {
        session.destroy();
    }
}

async function compareToReference(page, actualPng) {
    const name = page.toLowerCase();
    const expectedFile = path.join(RefDir, `${name}.png`);
    const actualFile = `${OutputDir}/actual_hardware_${name}.png`;
    const diffFile = `${OutputDir}/actual_hardware_${name}.diff.png`;

    await sharp(actualPng).toFile(actualFile);
    const { data: expected, info } = await sharp(expectedFile)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const actual = await sharp(actualPng).ensureAlpha().raw().toBuffer();
    const diff = new Uint8Array(info.width * info.height * info.channels);

    const numDiffPixels = pixelmatch(expected, actual, diff, info.width, info.height, { threshold: 0.1 });
    await sharp(diff, { raw: info }).removeAlpha().toFile(diffFile);
    assert.equal(
        numDiffPixels,
        0,
        `${page} does not match the hardware reference - expected ${expectedFile}, got ${actualFile}, diffs: ${diffFile}`,
    );
}

describe("Teletext hardware test disc", { timeout: 120000 }, () => {
    for (const page of Pages) {
        it(`should render ${page} as the hardware does`, async () => {
            await compareToReference(page, await renderPage(page));
        });
    }
});
