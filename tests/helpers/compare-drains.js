import {
    jsDrain,
    jsPaintTeletext,
    PendingOffsetMask,
    PendingOffsetShift,
    RowPixels,
    TeletextCellPixels,
    TeletextCellWords,
    TeletextOffsetShift,
} from "../../src/video-drain.js";

// A record draws from up to two rows above its biased offset (one for the bias, one for doubling's rounding) to a
// wide cell beyond it.
const RecordReachBefore = 2 * 1024;
const RecordReachAfter = 16;

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

// A teletext cell paints from its offset to a cell beyond it on the row below.
const TeletextReachAfter = RowPixels + TeletextCellPixels;

function teletextSpan(cells, count, length) {
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < count; ++i) {
        const offset = cells[TeletextCellWords * i + 1] >> TeletextOffsetShift;
        lowest = Math.min(lowest, offset);
        highest = Math.max(highest, offset);
    }
    return [Math.max(0, lowest), Math.min(length, highest + TeletextReachAfter)];
}

/**
 * Has every drain of `videoDrain` compare its framebuffer, line grid and drawn boxes with jsDrain's, over the
 * part of the framebuffer the records reach, and every teletext paint likewise with jsPaintTeletext's.
 * @param {import("../../src/video-drain.js").VideoDrain} videoDrain
 * @returns {{drains: number, teletextPaints: number, differences: string[]}} how many drains and teletext paints
 *     ran, and a description of each that differed
 */
export function checkDrainsAgainstJs(videoDrain) {
    const checked = { drains: 0, teletextPaints: 0, differences: [] };
    const { fb32, lineGrid, drawnBoxes, records, table4bpp, palette, teletextCells, teletextColour } = videoDrain;
    const drainUnderTest = videoDrain.drain;
    const paintUnderTest = videoDrain.paintTeletext;
    const expected = {
        records,
        fb32: new Int32Array(fb32.length),
        lineGrid: lineGrid.slice(),
        drawnBoxes: drawnBoxes.slice(),
        table4bpp,
        palette,
        teletextCells,
        teletextColour,
    };
    const compare = (what, count, start, end) => {
        const pixel = firstDifference(expected.fb32, fb32, start, end);
        const row = firstDifference(expected.lineGrid, lineGrid, 0, lineGrid.length);
        if (pixel >= 0 || row >= 0) {
            checked.differences.push(`${what} ${checked[what]} of ${count}: pixel ${pixel}, line grid row ${row}`);
        }
        ++checked[what];
    };
    videoDrain.drain = (count, modeBase, pixelsPerChar, doubledLines, lineGridValue) => {
        const [start, end] = touchedSpan(records, count, fb32.length);
        expected.fb32.set(fb32.subarray(start, end), start);
        expected.lineGrid.set(lineGrid);
        expected.drawnBoxes.set(drawnBoxes);
        jsDrain(expected, count, modeBase, pixelsPerChar, doubledLines, lineGridValue);
        drainUnderTest(count, modeBase, pixelsPerChar, doubledLines, lineGridValue);
        const box = firstDifference(expected.drawnBoxes, drawnBoxes, 0, drawnBoxes.length);
        if (box >= 0) checked.differences.push(`drains ${checked.drains} of ${count}: drawn box word ${box}`);
        compare("drains", count, start, end);
    };
    videoDrain.paintTeletext = (count) => {
        const [start, end] = teletextSpan(teletextCells, count, fb32.length);
        expected.fb32.set(fb32.subarray(start, end), start);
        expected.lineGrid.set(lineGrid);
        jsPaintTeletext(expected, count);
        paintUnderTest(count);
        compare("teletextPaints", count, start, end);
    };
    return checked;
}
