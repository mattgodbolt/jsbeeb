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
    const actual = await sharp(actualPng).ensureAlpha().raw().toBuffer();
    const diff = new Uint8Array(info.width * info.height * info.channels);

    const numDiffPixels = pixelmatch(expected, actual, diff, info.width, info.height, {
        threshold: PixelmatchThreshold,
    });
    await sharp(diff, { raw: info }).removeAlpha().toFile(diffFile);
    expect(numDiffPixels, `${mismatch} - expected ${expectedFile}, got ${actualFile}, diffs: ${diffFile}`).toBe(0);
}
