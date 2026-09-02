import { describe, it } from "vitest";
import path from "node:path";
import { Pages, RefDir, renderPage } from "../hardware/teletext/render-page.js";
import { expectPngToMatch } from "./helpers.js";

// The T1 to T6 and T8 reference images were checked against a real BBC Master 128
// running MOS 3.20 and agreed with it on every page, so they pin behaviour we have
// measured rather than behaviour we have merely chosen (T8's capture sat on the
// opposite power-on clock phase, a known half-cell ambiguity; the box widths and
// half-cell edges agreed). T7 awaits a photograph. See
// tests/hardware/teletext/README.md for what each page tests.
async function compareToReference(page, actualPng) {
    const name = page.toLowerCase();
    await expectPngToMatch(
        actualPng,
        path.join(RefDir, `${name}.png`),
        `actual_hardware_${name}`,
        `${page} does not match the hardware reference`,
    );
}

describe("Teletext hardware test disc", () => {
    for (const page of Pages) {
        it(`should render ${page} as the hardware does`, async () => {
            await compareToReference(page, await renderPage(page));
        });
    }
});
