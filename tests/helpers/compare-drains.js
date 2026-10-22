import { jsDrain, PendingOffsetMask, PendingRunWords } from "../../src/video-drain.js";

// A run draws from up to two rows above its biased offset (one for the bias, one for doubling's rounding) to the end
// of its row, the row below it when doubled, and a wide cell beyond that.
const RunReachBefore = 2 * 1024;
const RunReachAfter = 2 * 1024 + 16;

function firstDifference(expected, actual, start, end) {
    for (let i = start; i < end; ++i) if (expected[i] !== actual[i]) return i;
    return -1;
}

function touchedSpan(runs, runCount, length) {
    let lowest = Infinity;
    let highest = -Infinity;
    for (let header = 0; header < runCount * PendingRunWords; header += PendingRunWords) {
        const offset = runs[header] & PendingOffsetMask;
        lowest = Math.min(lowest, offset);
        highest = Math.max(highest, offset);
    }
    return [Math.max(0, lowest - RunReachBefore), Math.min(length, highest + RunReachAfter)];
}

/**
 * Has every drain of `videoDrain` compare its framebuffer and line grid with jsDrain's, over the part of the
 * framebuffer the runs reach.
 * @param {import("../../src/video-drain.js").VideoDrain} videoDrain
 * @returns {{drains: number, differences: string[]}} how many drains ran, and a description of each that differed
 */
export function checkDrainsAgainstJs(videoDrain) {
    const checked = { drains: 0, differences: [] };
    const { fb32, lineGrid, cells, runs, table4bpp, palette } = videoDrain;
    const drainUnderTest = videoDrain.drain;
    const expected = { cells, runs, fb32: new Int32Array(fb32.length), lineGrid: lineGrid.slice(), table4bpp, palette };
    videoDrain.drain = (runCount, modeBase, pixelsPerChar, doubledLines, lineGridValue) => {
        const [start, end] = touchedSpan(runs, runCount, fb32.length);
        expected.fb32.set(fb32.subarray(start, end), start);
        expected.lineGrid.set(lineGrid);
        jsDrain(expected, runCount, modeBase, pixelsPerChar, doubledLines, lineGridValue);
        drainUnderTest(runCount, modeBase, pixelsPerChar, doubledLines, lineGridValue);
        const pixel = firstDifference(expected.fb32, fb32, start, end);
        const row = firstDifference(expected.lineGrid, lineGrid, 0, lineGrid.length);
        if (pixel >= 0 || row >= 0) {
            checked.differences.push(
                `drain ${checked.drains} of ${runCount} runs: pixel ${pixel}, line grid row ${row}`,
            );
        }
        ++checked.drains;
    };
    return checked;
}
