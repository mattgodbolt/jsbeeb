import { describe, it } from "vitest";
import assert from "assert";
import path from "node:path";
import sharp from "sharp";
import pixelmatch from "pixelmatch";
import { Pages, RefDir, renderPage } from "../hardware/teletext/render-page.js";

// The T1 to T6 and T8 reference images were checked against a real BBC Master 128
// running MOS 3.20 and agreed with it on every page, so they pin behaviour we have
// measured rather than behaviour we have merely chosen (T8's capture sat on the
// opposite power-on clock phase, a known half-cell ambiguity; the box widths and
// half-cell edges agreed). T7 awaits a photograph. See
// tests/hardware/teletext/README.md for what each page tests.
const OutputDir = "tests/integration/output";

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

describe("Teletext hardware test disc", () => {
    for (const page of Pages) {
        it(`should render ${page} as the hardware does`, async () => {
            await compareToReference(page, await renderPage(page));
        });
    }
});
