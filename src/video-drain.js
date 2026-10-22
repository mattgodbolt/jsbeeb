import { assembleModule } from "./wasm-assembler.js";
import { LineGridRows } from "./video-filters/pixel-grid.js";

// A pending bitmap cell is one the beam has passed but the drain has not yet drawn: its video byte
// under its framebuffer offset. A cursor record is the offset of a cell to invert. An odd field
// starts at bitmapY -1, so the stored row is biased by one to keep the offset unsigned.
export const PendingRowBias = 1;
export const PendingOffsetShift = 8;
export const PendingOffsetMask = 0xfffff;
export const PendingByteMask = 0xff;
export const PendingCursor = 1 << 28;
// Flyback drains, and a field records at most 313 lines (bitmapY below 625 in steps of two) of 128
// cells and a few cursor inverts.
export const PendingCapacity = 1 << 16;
export const CursorInvert = 0x00ffffff;

const Table4bppBytes = 4 * 256 * 16;
const PaletteEntries = 16;
const RowShift = 10;
const RowPixels = 1 << RowShift;
const WordShift = 2;
const WordBytes = 1 << WordShift;
const RowBytes = RowPixels * WordBytes;
const TableRowShift = 4;
const WideCellPixels = 16;
const WasmPageBytes = 65536;

const TableOffset = 0;
const PaletteOffset = TableOffset + Table4bppBytes;
const LineGridOffset = PaletteOffset + PaletteEntries * 4;
const RecordsOffset = LineGridOffset + LineGridRows;
const FramebufferOffset = RecordsOffset + PendingCapacity * 4;
// A doubled cell on the last row writes the row below it, and a cell may run past the end of its row.
const FramebufferOverrunBytes = 2 * RowBytes;

const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);
const lanes = (indices) => indices.join(" ");
const InterleaveLow = lanes(range(0, 8).flatMap((i) => [i, 16 + i]));
const InterleaveHigh = lanes(range(8, 8).flatMap((i) => [i, 16 + i]));
const PairsLow = lanes(range(0, 4).flatMap((i) => [2 * i, 2 * i + 1, 16 + 2 * i, 17 + 2 * i]));
const PairsHigh = lanes(range(4, 4).flatMap((i) => [2 * i, 2 * i + 1, 16 + 2 * i, 17 + 2 * i]));

const DrainParams = ["count", "modeBase", "pixelsPerChar", "doubledLines", "lineGridValue"];
const DrainLocals = {
    i: "i32",
    record: "i32",
    raw: "i32",
    start: "i32",
    rowMask: "i32",
    expected: "i32",
    source: "i32",
    address: "i32",
    pixel: "i32",
    colour: "i32",
    at: "i32",
    span: "i32",
    rowsEnd: "i32",
    plane0: "v128",
    plane1: "v128",
    plane2: "v128",
    plane3: "v128",
    indices: "v128",
    byte0: "v128",
    byte1: "v128",
    byte2: "v128",
    byte3: "v128",
    bytes01: "v128",
    bytes23: "v128",
    low: "v128",
    high: "v128",
};

// Records whose offset is negative lie on the line above an odd field; only a cell's right end, spilling onto
// row 0, is drawn.
const DrawClipped = `
    local.get modeBase
    local.get record
    i32.const ${PendingByteMask}
    i32.and
    i32.const ${TableRowShift}
    i32.shl
    i32.add
    local.set source
    local.get doubledLines
    i32.const 1
    i32.add
    i32.const ${RowShift}
    i32.shl
    local.set span
    i32.const 0
    local.set pixel
    loop
        local.get start
        local.get pixel
        i32.add
        local.tee at
        local.get span
        i32.add
        local.set rowsEnd
        loop
            local.get at
            i32.const 0
            i32.ge_s
            if
                local.get at
                i32.const ${WordShift}
                i32.shl
                local.tee address
                local.get record
                i32.const ${PendingCursor}
                i32.and
                if
                    local.get address
                    i32.load offset=${FramebufferOffset}
                    i32.const ${CursorInvert}
                    i32.xor
                    local.set colour
                else
                    local.get source
                    local.get pixel
                    i32.add
                    i32.load8_u offset=${TableOffset}
                    i32.const ${WordShift}
                    i32.shl
                    i32.load offset=${PaletteOffset}
                    local.set colour
                end
                local.get colour
                i32.store offset=${FramebufferOffset}
            end
            local.get at
            i32.const ${RowPixels}
            i32.add
            local.tee at
            local.get rowsEnd
            i32.lt_s
            br_if 0
        end
        local.get pixel
        i32.const 1
        i32.add
        local.tee pixel
        local.get pixelsPerChar
        i32.lt_u
        br_if 0
    end`;

const InvertCursor = `
    local.get start
    i32.const ${WordShift}
    i32.shl
    local.set address
    i32.const 0
    local.set pixel
    loop
        local.get address
        local.get address
        i32.load offset=${FramebufferOffset}
        i32.const ${CursorInvert}
        i32.xor
        i32.store offset=${FramebufferOffset}
        local.get doubledLines
        if
            local.get address
            local.get address
            i32.load offset=${FramebufferOffset + RowBytes}
            i32.const ${CursorInvert}
            i32.xor
            i32.store offset=${FramebufferOffset + RowBytes}
        end
        local.get address
        i32.const ${WordBytes}
        i32.add
        local.set address
        local.get pixel
        i32.const 1
        i32.add
        local.tee pixel
        local.get pixelsPerChar
        i32.lt_u
        br_if 0
    end`;

const LowHalves = lanes([...range(0, 8), ...range(16, 8)]);
const HighHalves = lanes([...range(8, 8), ...range(24, 8)]);

// The palette is split into planes, one byte of every colour in each, so that a cell's sixteen palette
// indices select each byte of its pixels with one swizzle.
function twoPlanes(byte, firstPlane, secondPlane) {
    const bytesOfEightColours = lanes([
        ...range(0, 8).map((i) => 4 * i + byte),
        ...range(0, 8).map((i) => 4 * i + byte + 1),
    ]);
    return `
    i32.const 0
    v128.load offset=${PaletteOffset}
    i32.const 0
    v128.load offset=${PaletteOffset + 16}
    i8x16.shuffle ${bytesOfEightColours}
    local.set low
    i32.const 0
    v128.load offset=${PaletteOffset + 32}
    i32.const 0
    v128.load offset=${PaletteOffset + 48}
    i8x16.shuffle ${bytesOfEightColours}
    local.set high
    local.get low
    local.get high
    i8x16.shuffle ${LowHalves}
    local.set ${firstPlane}
    local.get low
    local.get high
    i8x16.shuffle ${HighHalves}
    local.set ${secondPlane}`;
}

const SplitPalette = twoPlanes(0, "plane0", "plane1") + twoPlanes(2, "plane2", "plane3");

function storeFourPixels(vector, byteOffset) {
    return `
        local.get address
        local.get ${vector}
        v128.store offset=${FramebufferOffset + byteOffset}
        local.get doubledLines
        if
            local.get address
            local.get ${vector}
            v128.store offset=${FramebufferOffset + RowBytes + byteOffset}
        end`;
}

function eightPixels(interleave, byteOffset) {
    return `
        local.get byte0
        local.get byte1
        i8x16.shuffle ${interleave}
        local.set bytes01
        local.get byte2
        local.get byte3
        i8x16.shuffle ${interleave}
        local.set bytes23
        local.get bytes01
        local.get bytes23
        i8x16.shuffle ${PairsLow}
        local.set low
        local.get bytes01
        local.get bytes23
        i8x16.shuffle ${PairsHigh}
        local.set high
        ${storeFourPixels("low", byteOffset)}
        ${storeFourPixels("high", byteOffset + 16)}`;
}

const DrawCell = `
    local.get source
    v128.load offset=${TableOffset}
    local.set indices
    local.get plane0
    local.get indices
    i8x16.swizzle
    local.set byte0
    local.get plane1
    local.get indices
    i8x16.swizzle
    local.set byte1
    local.get plane2
    local.get indices
    i8x16.swizzle
    local.set byte2
    local.get plane3
    local.get indices
    i8x16.swizzle
    local.set byte3
    ${eightPixels(InterleaveLow, 0)}
    local.get pixelsPerChar
    i32.const ${WideCellPixels}
    i32.eq
    if
        ${eightPixels(InterleaveHigh, 32)}
    end`;

// The line grid is written for the first cell of each run of adjacent cells.
const DrainCode = `
    ${SplitPalette}
    i32.const -1
    local.get doubledLines
    i32.const ${RowShift}
    i32.shl
    i32.xor
    local.set rowMask
    i32.const -1
    local.set expected
    block
        loop
            local.get i
            local.get count
            i32.ge_u
            br_if 1
            local.get i
            i32.const ${WordShift}
            i32.shl
            i32.load offset=${RecordsOffset}
            local.tee record
            i32.const ${PendingOffsetShift}
            i32.shr_u
            local.tee raw
            i32.const ${PendingOffsetMask}
            i32.and
            i32.const ${PendingRowBias * RowPixels}
            i32.sub
            local.get rowMask
            i32.and
            local.set start
            local.get i
            i32.const 1
            i32.add
            local.set i
            local.get start
            i32.const 0
            i32.lt_s
            if
                ${DrawClipped}
                i32.const -1
                local.set expected
                br 1
            end
            local.get record
            i32.const ${PendingCursor}
            i32.and
            if
                ${InvertCursor}
                i32.const -1
                local.set expected
                br 1
            end
            local.get raw
            local.get expected
            i32.ne
            if
                local.get start
                i32.const ${RowShift}
                i32.shr_u
                local.get lineGridValue
                i32.store8 offset=${LineGridOffset}
                local.get doubledLines
                if
                    local.get start
                    i32.const ${RowShift}
                    i32.shr_u
                    local.get lineGridValue
                    i32.store8 offset=${LineGridOffset + 1}
                end
            end
            local.get raw
            local.get pixelsPerChar
            i32.add
            local.set expected
            local.get modeBase
            local.get record
            i32.const ${PendingByteMask}
            i32.and
            i32.const ${TableRowShift}
            i32.shl
            i32.add
            local.set source
            local.get start
            i32.const ${WordShift}
            i32.shl
            local.set address
            ${DrawCell}
            br 0
        end
    end`;

const DrainModule = new WebAssembly.Module(
    assembleModule([{ name: "drain", params: DrainParams, locals: DrainLocals, code: DrainCode }]),
);

/**
 * The memory the bitmap renderer works in, holding the framebuffer, the line grid, the pending records,
 * table4bpp and the palette, and the Wasm function that draws the records. The memory never grows, so views
 * of it stay valid.
 */
export class VideoDrain {
    /** @param {number} framebufferPixels */
    constructor(framebufferPixels) {
        const bytes = FramebufferOffset + framebufferPixels * 4 + FramebufferOverrunBytes;
        const pages = Math.ceil(bytes / WasmPageBytes);
        const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
        const { buffer } = memory;
        this.table4bpp = new Uint8Array(buffer, TableOffset, Table4bppBytes);
        this.palette = new Int32Array(buffer, PaletteOffset, PaletteEntries);
        this.lineGrid = new Uint8Array(buffer, LineGridOffset, LineGridRows);
        this.records = new Int32Array(buffer, RecordsOffset, PendingCapacity);
        this.fb32 = new Int32Array(buffer, FramebufferOffset, framebufferPixels);
        const { exports } = new WebAssembly.Instance(DrainModule, { env: { memory } });
        /**
         * Draws the first `count` records, in order, in `palette`.
         * @type {(count: number, modeBase: number, pixelsPerChar: number, doubledLines: boolean,
         *     lineGridValue: number) => void}
         */
        this.drain = exports.drain;
    }
}
