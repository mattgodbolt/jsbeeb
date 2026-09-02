import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import pixelmatch from "pixelmatch";
import sharp from "sharp";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
export const RepoRoot = path.resolve(ScriptDir, "../..");
export const OutputDir = path.join(ScriptDir, "output");

const PixelmatchThreshold = 0.1;

/**
 * Writes `actualPng` and its diff against `expectedFile` into OutputDir as `<outputStem>.png` and
 * `<outputStem>.diff.png`, and fails naming all three files if any pixel differs.
 */
export async function expectPngToMatch(actualPng, expectedFile, outputStem, mismatch = "Images do not match") {
    const actualFile = path.join(OutputDir, `${outputStem}.png`);
    const diffFile = path.join(OutputDir, `${outputStem}.diff.png`);

    await sharp(actualPng).toFile(actualFile);
    const { data: expected, info } = await sharp(expectedFile)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { data: actual, info: actualInfo } = await sharp(actualPng)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const shape = ({ width, height, channels }) => ({ width, height, channels });
    expect(shape(actualInfo), `${mismatch} - expected ${expectedFile}, got ${actualFile}`).toEqual(shape(info));
    const diff = new Uint8Array(info.width * info.height * info.channels);

    const numDiffPixels = pixelmatch(expected, actual, diff, info.width, info.height, {
        threshold: PixelmatchThreshold,
    });
    await sharp(diff, { raw: info }).removeAlpha().toFile(diffFile);
    expect(numDiffPixels, `${mismatch} - expected ${expectedFile}, got ${actualFile}, diffs: ${diffFile}`).toBe(0);
}

const Mode7ScreenStart = 0x7c00;
const Mode7ScreenEnd = 0x8000;

/** The mode 7 screen as text, unprintable bytes as spaces. */
export function mode7Text(machine) {
    let text = "";
    for (let addr = Mode7ScreenStart; addr < Mode7ScreenEnd; addr++) {
        const c = machine.readbyte(addr);
        text += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ";
    }
    return text;
}
