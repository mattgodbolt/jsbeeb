import {
    CursorInvert,
    PendingByteMask,
    PendingCursor,
    PendingOffsetMask,
    PendingOffsetShift,
    PendingRowBias,
} from "../../src/video-drain.js";

function invertCell(fb32, offset, pixelsPerChar, doubledLines) {
    for (let i = 0; i < pixelsPerChar; ++i) fb32[offset + i] ^= CursorInvert;
    if (doubledLines) {
        for (let i = 1024; i < 1024 + pixelsPerChar; ++i) fb32[offset + i] ^= CursorInvert;
    }
}

// A cell on the line above an odd field, whose right end spills onto row 0.
function drawClippedCell(
    fb32,
    record,
    start,
    table4bpp,
    modeBase,
    palette,
    pixelsPerChar,
    doubledLines,
    cursorDoubled,
) {
    const cursor = (record & PendingCursor) !== 0;
    const secondRow = cursor ? cursorDoubled : doubledLines;
    const source = modeBase | ((record & PendingByteMask) << 4);
    for (let p = 0; p < pixelsPerChar; ++p) {
        for (let at = start + p; at < start + p + (secondRow ? 2048 : 1024); at += 1024) {
            if (at < 0) continue;
            fb32[at] = cursor ? fb32[at] ^ CursorInvert : palette[table4bpp[source + p]];
        }
    }
}

/**
 * Draws pending records into fb32, in order. Adjacent cells form a run, which is drawn on its
 * first row and copied to the second at once when lines are doubled.
 * @param {Int32Array} records
 * @param {number} count
 * @param {Uint32Array} fb32
 * @param {Uint8Array} lineGrid
 * @param {Uint8Array} table4bpp
 * @param {number} modeBase the table4bpp offset of byte 0 in the ULA mode
 * @param {Uint32Array} palette
 * @param {number} pixelsPerChar
 * @param {boolean} doubledLines
 * @param {boolean} cursorDoubled whether the cursor inverts the second row too
 * @param {number} lineGridValue
 */
export function renderPendingCells(
    records,
    count,
    fb32,
    lineGrid,
    table4bpp,
    modeBase,
    palette,
    pixelsPerChar,
    doubledLines,
    cursorDoubled,
    lineGridValue,
) {
    const rowMask = doubledLines ? ~1024 : ~0;
    const biasedOrigin = PendingRowBias * 1024;
    let i = 0;
    while (i < count) {
        let record = records[i];
        const start = (((record >>> PendingOffsetShift) & PendingOffsetMask) - biasedOrigin) & rowMask;
        if (start < 0) {
            drawClippedCell(
                fb32,
                record,
                start,
                table4bpp,
                modeBase,
                palette,
                pixelsPerChar,
                doubledLines,
                cursorDoubled,
            );
            ++i;
            continue;
        }
        if (record & PendingCursor) {
            invertCell(fb32, start, pixelsPerChar, cursorDoubled);
            ++i;
            continue;
        }
        let end = start;
        for (;;) {
            const source = modeBase | ((record & PendingByteMask) << 4);
            for (let p = 0; p < pixelsPerChar; ++p) fb32[end + p] = palette[table4bpp[source + p]];
            end += pixelsPerChar;
            if (++i === count) break;
            const next = records[i];
            if ((next >> PendingOffsetShift) - (record >> PendingOffsetShift) !== pixelsPerChar) break;
            record = next;
        }
        const row = start >>> 10;
        lineGrid[row] = lineGridValue;
        if (doubledLines) {
            lineGrid[row + 1] = lineGridValue;
            fb32.copyWithin(start + 1024, start, end);
        }
    }
}

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
 * Has every drain of `videoDrain` run each Wasm variant from the same starting framebuffer and line grid, and
 * compare them with renderPendingCells over the part of the framebuffer the records reach. The last variant's
 * output is the one kept.
 * @param {import("../../src/video-drain.js").VideoDrain} videoDrain
 * @returns {{drains: number, differences: string[]}} how many drains ran, and a description of each that differed
 */
export function checkDrainsAgainstReference(videoDrain) {
    const checked = { drains: 0, differences: [] };
    const { fb32, lineGrid, records, table4bpp, palette } = videoDrain;
    const expectedFb32 = new Int32Array(fb32.length);
    videoDrain.drain = (count, modeBase, pixelsPerChar, doubledLines, cursorDoubled, lineGridValue) => {
        const [start, end] = touchedSpan(records, count, fb32.length);
        const fb32Before = fb32.slice(start, end);
        const lineGridBefore = lineGrid.slice();
        const expectedLineGrid = lineGrid.slice();
        expectedFb32.set(fb32Before, start);
        renderPendingCells(
            records,
            count,
            expectedFb32,
            expectedLineGrid,
            table4bpp,
            modeBase,
            palette,
            pixelsPerChar,
            doubledLines,
            cursorDoubled,
            lineGridValue,
        );
        for (const [name, drain] of Object.entries(videoDrain.variants)) {
            fb32.set(fb32Before, start);
            lineGrid.set(lineGridBefore);
            drain(count, modeBase, pixelsPerChar, doubledLines, cursorDoubled, lineGridValue);
            const pixel = firstDifference(expectedFb32, fb32, start, end);
            const row = firstDifference(expectedLineGrid, lineGrid, 0, lineGrid.length);
            if (pixel >= 0 || row >= 0) {
                checked.differences.push(
                    `${name}, drain ${checked.drains} of ${count} records: pixel ${pixel}, line grid row ${row}`,
                );
            }
        }
        ++checked.drains;
    };
    return checked;
}
