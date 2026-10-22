import { jsDrain, PendingOffsetMask, PendingOffsetShift } from "../../src/video-drain.js";

// A record draws from the row above its biased offset, and onto the next row, a cell or so beyond it.
const RecordReachBefore = 2 * 1024;
const RecordReachAfter = 1024 + 32;

function firstDifference(expected, actual, start, end) {
    for (let i = start; i < end; ++i) if (expected[i] !== actual[i]) return i;
    return -1;
}

function touchedSpan(records, count, length) {
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < count; ++i) {
        const offset = (records[i] >>> PendingOffsetShift) & PendingOffsetMask;
        lowest = Math.min(lowest, offset);
        highest = Math.max(highest, offset);
    }
    return [Math.max(0, lowest - RecordReachBefore), Math.min(length, highest + RecordReachAfter)];
}

/**
 * Has every drain of `videoDrain` compare its framebuffer and line grid with jsDrain's, over the part of the
 * framebuffer the records reach.
 * @param {import("../../src/video-drain.js").VideoDrain} videoDrain
 * @returns {{drains: number, differences: string[]}} how many drains ran, and a description of each that differed
 */
export function checkDrainsAgainstJs(videoDrain) {
    const checked = { drains: 0, differences: [] };
    const { fb32, lineGrid, records, table4bpp, palette } = videoDrain;
    const drainUnderTest = videoDrain.drain;
    const expected = { records, fb32: new Int32Array(fb32.length), lineGrid: lineGrid.slice(), table4bpp, palette };
    videoDrain.drain = (count, modeBase, pixelsPerChar, doubledLines, lineGridValue) => {
        const [start, end] = touchedSpan(records, count, fb32.length);
        expected.fb32.set(fb32.subarray(start, end), start);
        expected.lineGrid.set(lineGrid);
        jsDrain(expected, count, modeBase, pixelsPerChar, doubledLines, lineGridValue);
        drainUnderTest(count, modeBase, pixelsPerChar, doubledLines, lineGridValue);
        const pixel = firstDifference(expected.fb32, fb32, start, end);
        const row = firstDifference(expected.lineGrid, lineGrid, 0, lineGrid.length);
        if (pixel >= 0 || row >= 0) {
            checked.differences.push(
                `drain ${checked.drains} of ${count} records: pixel ${pixel}, line grid row ${row}`,
            );
        }
        ++checked.drains;
    };
    return checked;
}
