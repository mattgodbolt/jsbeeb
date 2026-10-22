// The drain: turns pending bitmap cells, recorded by Video as the beam passes them, into framebuffer pixels. There
// are two implementations of it, a WebAssembly SIMD function assembled at load and a plain JS one. They work on the
// same memory and draw the same pixels; the Wasm is used wherever the browser can compile it, and the JS otherwise
// (WebAssembly switched off, as in Safari's Lockdown Mode, or a content security policy that forbids compiling it).
// The JS also documents the Wasm: DrawClipped, InvertCursor, DrawCell, CellSource and DrainCode below pair with the JS
// functions drawClipped, invertCursor, drawCell, cellSource and jsDrain further down, step for step and with the same
// local names.
//
// THE MEMORY
//
// One block of memory holds everything the drain reads and writes. For the Wasm it is a WebAssembly.Memory created at
// its final size and never grown (growing would detach its ArrayBuffer and every view of it); for the JS it is an
// ArrayBuffer of the same size and layout. Video's fb32, lineGrid, table4bpp, pendingCells and pendingRuns are views
// of it.
//
//   Offset   Size (bytes)                Region
//   0        16384                       table4bpp: for each of the 4 ULA modes and 256 video bytes, the palette
//                                        index (0 to 15) of each of up to 16 pixels, one byte each, so a cell's
//                                        indices are 16 consecutive bytes at (mode << 12) | (byte << 4).
//   16384    64                          palette: 16 colours, each an RGBA word (R in the lowest byte), copied in
//                                        by Video before each drain.
//   16448    1024                        line grid: one byte per framebuffer row, the pixel size it was drawn at
//                                        (see pixel-grid.js); the drain writes it for bitmap runs, Video for
//                                        teletext rows.
//   17472    65536                       cells: up to 65536 pending video bytes, one per cell, in beam order.
//   83008    8 * (131072 + 1), padded    runs: up to 131072 pending headers, two i32 each, and one more after the
//            to 16                       last for where its cells end.
//   1131600  4 * framebufferPixels       framebuffer: 1024 RGBA words per row.
//            + 8192                      overrun: room for a doubled cell's second row below the last row, and a
//                                        cell running past the end of its row.
//
// THE RECORDS
//
// Within a scanline the beam moves pixelsPerChar pixels a cell, so Video records a run of adjacent cells as their
// video bytes, one after another in the cells, and one header in the runs for the whole run. A header is two words:
//
//   word 0, the position:
//     bits 0 to 19   the first cell's framebuffer offset in pixels, plus one row (1024) so an odd field's row -1 is
//                    positive
//     bit 20         set for a cursor: no cells, but the ULA inverts its output at that cell
//   word 1           the index in the cells of the run's first cell
//
// A run's cells end where the next header's begin. Video writes the first-cell word of the header after the last, so
// the last run ends there too. A cursor's header begins and ends where the next run begins, so it has no cells.
//
// THE ALGORITHM, for each header in order
//
// 1. Decode: `start` is the offset with the bias removed, rounded down to an even row when lines are doubled; the
//    run's cells are `cell` up to `cellsEnd`.
// 2. A cursor inverts the RGB of the pixels at start, as the ULA inverts whatever it outputs for the cursor's cells,
//    on both rows when lines are doubled (invertCursor). On the line above an odd field only the pixels spilling onto
//    row 0 are inverted (drawClipped).
// 3. A negative `start` is a run on the line above an odd field; only each cell's right end, spilling onto row 0, is
//    drawn, pixel by pixel (drawClipped).
// 4. Otherwise the run writes the line grid for its row, and for the row below when lines are doubled, and draws each
//    of its cells pixelsPerChar pixels on from the last. A cell's `source` is where its 16 palette indices are in
//    table4bpp.
// 5. The cell is drawn (drawCell). The JS looks each pixel's colour up through table4bpp and the palette. The Wasm
//    does the whole cell with vectors:
//    - Once per drain, SplitPalette splits the 16 palette colours into four 16-byte "planes": plane0 holds byte 0
//      (red) of every colour, plane1 byte 1 (green), plane2 blue, plane3 alpha.
//    - Per cell, one 128-bit load fetches the cell's 16 palette indices from table4bpp, and four i8x16.swizzle
//      operations use them to pick each pixel's red, green, blue and alpha out of the planes: byte0 is then the red
//      of pixels 0 to 15, and so on.
//    - Shuffles interleave those back into RGBA words: red with green and blue with alpha, a byte at a time, then
//      those pairs two bytes at a time, giving four pixels per vector.
//    - Each vector of four pixels is one 128-bit store, made again one row (4096 bytes) down when lines are doubled.
//      An 8 pixel cell is two stores (eightPixels once); a 16 pixel cell is four (eightPixels twice).

import { assembleModule } from "./wasm-assembler.js";
import { LineGridRows } from "./video-filters/pixel-grid.js";

export const PendingRowBias = 1;
export const PendingOffsetMask = 0xfffff;
export const PendingCursor = 1 << 20;
export const PendingRunWords = 2;
// Flyback drains, and a field passes at most 313 rows (bitmapY below 625 in steps of two) of 128 cell positions. Each
// position adds at most one cell, and two headers: a run starting there and a cursor.
export const PendingCellCapacity = 1 << 16;
const PendingRunCapacity = 2 * PendingCellCapacity;
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
const VectorBytes = 16;
const RunBytes = PendingRunWords * WordBytes;
const RunShift = 3;
const FirstCellByte = WordBytes;

const alignToVector = (offset) => Math.ceil(offset / VectorBytes) * VectorBytes;

const TableOffset = 0;
const PaletteOffset = TableOffset + Table4bppBytes;
const LineGridOffset = PaletteOffset + PaletteEntries * WordBytes;
const CellsOffset = LineGridOffset + LineGridRows;
const RunsOffset = CellsOffset + PendingCellCapacity;
const FramebufferOffset = alignToVector(RunsOffset + (PendingRunCapacity + 1) * RunBytes);
const FramebufferOverrunBytes = 2 * RowBytes;

const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);
const lanes = (indices) => indices.join(" ");
// For i8x16.shuffle a b: lanes 0 to 15 pick from a, lanes 16 to 31 from b.
const InterleaveLow = lanes(range(0, 8).flatMap((i) => [i, 16 + i]));
const InterleaveHigh = lanes(range(8, 8).flatMap((i) => [i, 16 + i]));
const PairsLow = lanes(range(0, 4).flatMap((i) => [2 * i, 2 * i + 1, 16 + 2 * i, 17 + 2 * i]));
const PairsHigh = lanes(range(4, 4).flatMap((i) => [2 * i, 2 * i + 1, 16 + 2 * i, 17 + 2 * i]));
const LowHalves = lanes([...range(0, 8), ...range(16, 8)]);
const HighHalves = lanes([...range(8, 8), ...range(24, 8)]);

const DrainParams = ["runCount", "modeBase", "pixelsPerChar", "doubledLines", "lineGridValue"];
const DrainLocals = {
    header: "i32",
    headersEnd: "i32",
    position: "i32",
    cell: "i32",
    cellsEnd: "i32",
    start: "i32",
    rowMask: "i32",
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

// The Wasm below is the text format, one instruction per line. Wasm is a stack machine: each instruction pops its
// operands and pushes its result. "[a, b]" is the stack's top, b on top; locals are named as in DrainLocals.
// Memory accesses address the shared memory: the address popped plus the instruction's constant offset, so
// `i32.load offset=FramebufferOffset` with pixel * 4 on the stack reads fb32[pixel].

// A cell or cursor on the line above an odd field: start is negative, on row -1, or row -2 when doubling rounds it
// down to an even row. The loops visit the cell's pixels on its row and, when doubled, the row below; only those at
// or after offset 0 (the cell's right end, spilling past the end of row -1 onto row 0) are drawn, one pixel at a time.
// A cursor inverts them instead. Pairs with drawClipped in JS.
const DrawClipped = `
    local.get doubledLines              ;; [doubledLines], 0 or 1
    i32.const 1
    i32.add                             ;; [rows], 1 or 2
    i32.const ${RowShift}
    i32.shl                             ;; [rows * 1024], the pixels from a pixel to below its last row
    local.set span
    i32.const 0
    local.set pixel                     ;; pixel = 0
    loop                                ;; for each pixel of the cell
        local.get start
        local.get pixel
        i32.add
        local.tee at                    ;; at = start + pixel, on the cell's row; [at]
        local.get span
        i32.add
        local.set rowsEnd               ;; rowsEnd = at + span
        loop                            ;; for at on the cell's row (then the row below when doubled)
            local.get at
            i32.const 0
            i32.ge_s                    ;; [at >= 0]
            if                          ;; only pixels inside the framebuffer
                local.get at
                i32.const ${WordShift}
                i32.shl
                local.tee address       ;; address = at * 4, left on the stack for the store below; [address]
                local.get position
                i32.const ${PendingCursor}
                i32.and                 ;; [address, cursor bit]
                if                      ;; a cursor: invert what is there
                    local.get address
                    i32.load offset=${FramebufferOffset}  ;; [address, fb32[at]]
                    i32.const ${CursorInvert}
                    i32.xor
                    local.set colour    ;; colour = fb32[at] ^ CursorInvert; [address]
                else                    ;; a cell: look the pixel's colour up
                    local.get source
                    local.get pixel
                    i32.add
                    i32.load8_u offset=${TableOffset}     ;; [address, table4bpp[source + pixel]], a palette index
                    i32.const ${WordShift}
                    i32.shl
                    i32.load offset=${PaletteOffset}      ;; [address, palette[index]]
                    local.set colour    ;; [address]
                end
                local.get colour
                i32.store offset=${FramebufferOffset}     ;; fb32[at] = colour; []
            end
            local.get at
            i32.const ${RowPixels}
            i32.add
            local.tee at                ;; at += 1024, the same pixel a row down; [at]
            local.get rowsEnd
            i32.lt_s
            br_if 0                     ;; repeat the inner loop while at < rowsEnd
        end
        local.get pixel
        i32.const 1
        i32.add
        local.tee pixel                 ;; [++pixel]
        local.get pixelsPerChar
        i32.lt_u
        br_if 0                         ;; repeat the outer loop while pixel < pixelsPerChar
    end`;

// Inverts the RGB of the cell's pixels at start, and of those a row down when lines are doubled. Pairs with
// invertCursor in JS.
const InvertCursor = `
    local.get start
    i32.const ${WordShift}
    i32.shl
    local.set address                   ;; address = start * 4, the cell's first pixel
    i32.const 0
    local.set pixel                     ;; pixel = 0
    loop                                ;; for each pixel of the cell
        local.get address               ;; [address], for the store
        local.get address
        i32.load offset=${FramebufferOffset}              ;; [address, the pixel]
        i32.const ${CursorInvert}
        i32.xor                         ;; [address, the pixel with its RGB inverted]
        i32.store offset=${FramebufferOffset}             ;; written back; []
        local.get doubledLines
        if                              ;; the same a row down
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
        local.set address               ;; address += 4, the next pixel
        local.get pixel
        i32.const 1
        i32.add
        local.tee pixel                 ;; [++pixel]
        local.get pixelsPerChar
        i32.lt_u
        br_if 0                         ;; repeat while pixel < pixelsPerChar
    end`;

// Fills two planes: firstPlane with byte `byte` of each of the 16 colours, secondPlane with byte `byte + 1`. In lane
// terms, with cN.k for byte k of colour N (four bytes a colour, so the palette's first vector is
// c0.0 c0.1 c0.2 c0.3 c1.0 ... c3.3):
//   low         = c0.k ... c7.k, c0.k+1 ... c7.k+1      (from colours 0 to 7, the first two vectors)
//   high        = c8.k ... c15.k, c8.k+1 ... c15.k+1    (from colours 8 to 15, the last two)
//   firstPlane  = c0.k ... c7.k, c8.k ... c15.k         (the low halves of low and high)
//   secondPlane = c0.k+1 ... c15.k+1                    (their high halves)
// SplitPalette has no JS counterpart: the JS indexes the palette directly.
function twoPlanes(byte, firstPlane, secondPlane) {
    const bytesOfEightColours = lanes([
        ...range(0, 8).map((i) => 4 * i + byte),
        ...range(0, 8).map((i) => 4 * i + byte + 1),
    ]);
    return `
    i32.const 0
    v128.load offset=${PaletteOffset}       ;; [colours 0 to 3]
    i32.const 0
    v128.load offset=${PaletteOffset + 16}  ;; [colours 0 to 3, colours 4 to 7]
    i8x16.shuffle ${bytesOfEightColours}
    local.set low                           ;; low = byte ${byte} of colours 0 to 7, then byte ${byte + 1}
    i32.const 0
    v128.load offset=${PaletteOffset + 32}  ;; [colours 8 to 11]
    i32.const 0
    v128.load offset=${PaletteOffset + 48}  ;; [colours 8 to 11, colours 12 to 15]
    i8x16.shuffle ${bytesOfEightColours}
    local.set high                          ;; high = byte ${byte} of colours 8 to 15, then byte ${byte + 1}
    local.get low
    local.get high
    i8x16.shuffle ${LowHalves}
    local.set ${firstPlane}                 ;; byte ${byte} of colours 0 to 15
    local.get low
    local.get high
    i8x16.shuffle ${HighHalves}
    local.set ${secondPlane}                ;; byte ${byte + 1} of colours 0 to 15`;
}

const SplitPalette = twoPlanes(0, "plane0", "plane1") + twoPlanes(2, "plane2", "plane3");

// Stores four pixels at the cell's address plus byteOffset, and again a row down when lines are doubled.
function storeFourPixels(vector, byteOffset) {
    return `
        local.get address
        local.get ${vector}                 ;; [address, four RGBA pixels]
        v128.store offset=${FramebufferOffset + byteOffset}
        local.get doubledLines
        if                                  ;; the same pixels a row down
            local.get address
            local.get ${vector}
            v128.store offset=${FramebufferOffset + RowBytes + byteOffset}
        end`;
}

// Builds and stores eight pixels from byte0 to byte3, which hold the red, green, blue and alpha of each of the cell's
// sixteen pixels: pixels 0 to 7 with InterleaveLow, 8 to 15 with InterleaveHigh. With Rn for pixel n's red and so on,
// for pixels 0 to 7:
//   bytes01 = R0 G0 R1 G1 ... R7 G7
//   bytes23 = B0 A0 B1 A1 ... B7 A7
//   low     = R0 G0 B0 A0 R1 G1 B1 A1 R2 G2 B2 A2 R3 G3 B3 A3, pixels 0 to 3 as four RGBA words
//   high    = pixels 4 to 7 likewise
function eightPixels(interleave, byteOffset) {
    return `
        local.get byte0
        local.get byte1
        i8x16.shuffle ${interleave}
        local.set bytes01                   ;; red and green of eight pixels, alternating
        local.get byte2
        local.get byte3
        i8x16.shuffle ${interleave}
        local.set bytes23                   ;; blue and alpha of the same pixels, alternating
        local.get bytes01
        local.get bytes23
        i8x16.shuffle ${PairsLow}
        local.set low                       ;; the first four as RGBA words
        local.get bytes01
        local.get bytes23
        i8x16.shuffle ${PairsHigh}
        local.set high                      ;; the last four as RGBA words
        ${storeFourPixels("low", byteOffset)}
        ${storeFourPixels("high", byteOffset + 16)}`;
}

// Draws the cell whose palette indices are at source into the framebuffer at address, and a row down when lines are
// doubled. Pairs with drawCell in JS.
const DrawCell = `
    local.get source
    v128.load offset=${TableOffset}         ;; [the palette index of each of the cell's 16 pixels, one per lane]
    local.set indices
    local.get plane0
    local.get indices                       ;; [reds by colour, colour by pixel]
    i8x16.swizzle                           ;; lane n = plane0[indices[n]], pixel n's red
    local.set byte0
    local.get plane1
    local.get indices
    i8x16.swizzle
    local.set byte1                         ;; each pixel's green
    local.get plane2
    local.get indices
    i8x16.swizzle
    local.set byte2                         ;; each pixel's blue
    local.get plane3
    local.get indices
    i8x16.swizzle
    local.set byte3                         ;; each pixel's alpha
    ${eightPixels(InterleaveLow, 0)}
    local.get pixelsPerChar
    i32.const ${WideCellPixels}
    i32.eq
    if                                      ;; a 16 pixel cell: pixels 8 to 15, 32 bytes on
        ${eightPixels(InterleaveHigh, 32)}
    end`;

// Sets source to where the palette indices of the video byte cells[cell] are in table4bpp. Pairs with cellSource in
// JS.
const CellSource = `
        local.get modeBase
        local.get cell
        i32.load8_u offset=${CellsOffset}       ;; [modeBase, cells[cell]]
        i32.const ${TableRowShift}
        i32.shl
        i32.add
        local.set source                        ;; source = modeBase + (cells[cell] << 4)`;

// Moves start on to the next cell, and repeats the enclosing loop while there is one.
const NextCell = `
        local.get start
        local.get pixelsPerChar
        i32.add
        local.set start                         ;; start += pixelsPerChar
        local.get cell
        i32.const 1
        i32.add
        local.tee cell                          ;; [++cell]
        local.get cellsEnd
        i32.lt_u
        br_if 0                                 ;; repeat while cell < cellsEnd`;

// drain(runCount, modeBase, pixelsPerChar, doubledLines, lineGridValue): the whole function. Pairs with jsDrain.
const DrainCode = `
    ${SplitPalette}
    i32.const -1
    local.get doubledLines
    i32.const ${RowShift}
    i32.shl                                 ;; [-1, 1024 when doubled, else 0]
    i32.xor
    local.set rowMask                       ;; rowMask = ~1024 when doubled, clearing a row's odd bit, else ~0
    local.get runCount
    i32.const ${RunShift}
    i32.shl
    local.set headersEnd                    ;; headersEnd = runCount * 8, the bytes of headers to draw
    block                                   ;; br 1 from the loop body leaves this, ending the drain
        loop                                ;; for each header; br 0 from its body is "continue"
            local.get header
            local.get headersEnd
            i32.ge_u
            br_if 1                         ;; done when header >= headersEnd
            local.get header
            i32.load offset=${RunsOffset}
            local.set position              ;; position = the header's word 0
            local.get header
            i32.load offset=${RunsOffset + FirstCellByte}
            local.set cell                  ;; cell = its word 1, its first cell
            local.get header
            i32.load offset=${RunsOffset + RunBytes + FirstCellByte}
            local.set cellsEnd              ;; cellsEnd = the next header's first cell
            local.get header
            i32.const ${RunBytes}
            i32.add
            local.set header                ;; header += 8, the next header
            local.get position
            i32.const ${PendingOffsetMask}
            i32.and                         ;; [the biased offset]
            i32.const ${PendingRowBias * RowPixels}
            i32.sub                         ;; [the offset]
            local.get rowMask
            i32.and
            local.set start                 ;; start = offset & rowMask
            local.get position
            i32.const ${PendingCursor}
            i32.and
            if                              ;; a cursor
                local.get start
                i32.const 0
                i32.lt_s
                if                          ;; start < 0: the line above an odd field
                    ${DrawClipped}
                else
                    ${InvertCursor}
                end
                br 1                        ;; continue (depth 0 is this if, 1 the loop)
            end
            local.get start
            i32.const 0
            i32.lt_s
            if                              ;; start < 0: a run on the line above an odd field
                loop                        ;; for each cell of the run
                    ${CellSource}
                    ${DrawClipped}
                    ${NextCell}
                end
                br 1                        ;; continue
            end
            local.get start
            i32.const ${RowShift}
            i32.shr_u                       ;; [row]
            local.get lineGridValue
            i32.store8 offset=${LineGridOffset}           ;; lineGrid[row] = lineGridValue
            local.get doubledLines
            if                              ;; and the row below it when lines are doubled
                local.get start
                i32.const ${RowShift}
                i32.shr_u
                local.get lineGridValue
                i32.store8 offset=${LineGridOffset + 1}   ;; lineGrid[row + 1] = lineGridValue
            end
            loop                            ;; for each cell of the run
                ${CellSource}
                local.get start
                i32.const ${WordShift}
                i32.shl
                local.set address           ;; address = start * 4
                ${DrawCell}
                ${NextCell}
            end
            br 0                            ;; continue
        end
    end`;

const DrainModuleBytes = assembleModule([{ name: "drain", params: DrainParams, locals: DrainLocals, code: DrainCode }]);

// Compiling fails where WebAssembly or its SIMD is switched off or forbidden, and then the JS drain is used.
function compileDrainModule() {
    if (typeof WebAssembly !== "object") {
        console.info("WebAssembly is unavailable, so the video drain falls back to JavaScript");
        return null;
    }
    try {
        return new WebAssembly.Module(DrainModuleBytes);
    } catch (error) {
        console.info(`Couldn't compile the Wasm video drain, so it falls back to JavaScript: ${error.message}`);
        return null;
    }
}

const DrainModule = compileDrainModule();

/** The drain this browser runs: "wasm" when it can compile the module, else "js". */
export const PreferredDrain = DrainModule ? "wasm" : "js";

function drawClipped({ fb32, table4bpp, palette }, position, source, start, pixelsPerChar, doubledLines) {
    const span = (Number(doubledLines) + 1) << RowShift;
    for (let pixel = 0; pixel < pixelsPerChar; ++pixel) {
        const rowsEnd = start + pixel + span;
        for (let at = start + pixel; at < rowsEnd; at += RowPixels) {
            if (at < 0) continue;
            fb32[at] = position & PendingCursor ? fb32[at] ^ CursorInvert : palette[table4bpp[source + pixel]];
        }
    }
}

function invertCursor({ fb32 }, start, pixelsPerChar, doubledLines) {
    for (let pixel = 0; pixel < pixelsPerChar; ++pixel) {
        fb32[start + pixel] ^= CursorInvert;
        if (doubledLines) fb32[start + RowPixels + pixel] ^= CursorInvert;
    }
}

function drawCell({ fb32, table4bpp, palette }, source, start, pixelsPerChar, doubledLines) {
    for (let pixel = 0; pixel < pixelsPerChar; ++pixel) {
        const colour = palette[table4bpp[source + pixel]];
        fb32[start + pixel] = colour;
        if (doubledLines) fb32[start + RowPixels + pixel] = colour;
    }
}

const cellSource = ({ cells }, modeBase, cell) => modeBase + (cells[cell] << TableRowShift);

/**
 * Draws the first `runCount` headers of `views`, in order, in its palette: the JS drain, the same as the Wasm one.
 * @param {{cells: Uint8Array, runs: Int32Array, fb32: Int32Array, lineGrid: Uint8Array, table4bpp: Uint8Array,
 *     palette: Int32Array}} views
 * @param {number} runCount
 * @param {number} modeBase the table4bpp offset of byte 0 in the ULA mode
 * @param {number} pixelsPerChar
 * @param {boolean} doubledLines
 * @param {number} lineGridValue
 */
export function jsDrain(views, runCount, modeBase, pixelsPerChar, doubledLines, lineGridValue) {
    const { runs, lineGrid } = views;
    const rowMask = ~(Number(doubledLines) << RowShift);
    for (let header = 0; header < runCount * PendingRunWords;) {
        const position = runs[header];
        let cell = runs[header + 1];
        const cellsEnd = runs[header + PendingRunWords + 1];
        header += PendingRunWords;
        let start = ((position & PendingOffsetMask) - PendingRowBias * RowPixels) & rowMask;
        if (position & PendingCursor) {
            if (start < 0) {
                drawClipped(views, position, 0, start, pixelsPerChar, doubledLines);
            } else {
                invertCursor(views, start, pixelsPerChar, doubledLines);
            }
            continue;
        }
        if (start < 0) {
            do {
                drawClipped(views, position, cellSource(views, modeBase, cell), start, pixelsPerChar, doubledLines);
                start += pixelsPerChar;
            } while (++cell < cellsEnd);
            continue;
        }
        lineGrid[start >>> RowShift] = lineGridValue;
        if (doubledLines) lineGrid[(start >>> RowShift) + 1] = lineGridValue;
        do {
            drawCell(views, cellSource(views, modeBase, cell), start, pixelsPerChar, doubledLines);
            start += pixelsPerChar;
        } while (++cell < cellsEnd);
    }
}

/**
 * The memory the bitmap renderer works in, holding the framebuffer, the line grid, the pending cells and runs,
 * table4bpp and the palette, and the drain that draws them. The memory never grows, so views
 * of it stay valid.
 */
export class VideoDrain {
    /**
     * @param {number} framebufferPixels
     * @param {"wasm"|"js"} kind which drain to run; PreferredDrain is the one this browser can
     */
    constructor(framebufferPixels, kind) {
        if (kind === "wasm" && !DrainModule) throw new Error("WebAssembly SIMD is not available for the video drain");
        const bytes = FramebufferOffset + framebufferPixels * WordBytes + FramebufferOverrunBytes;
        const pages = Math.ceil(bytes / WasmPageBytes);
        const memory = kind === "wasm" ? new WebAssembly.Memory({ initial: pages, maximum: pages }) : null;
        const buffer = memory ? memory.buffer : new ArrayBuffer(pages * WasmPageBytes);
        this.kind = kind;
        this.table4bpp = new Uint8Array(buffer, TableOffset, Table4bppBytes);
        this.palette = new Int32Array(buffer, PaletteOffset, PaletteEntries);
        this.lineGrid = new Uint8Array(buffer, LineGridOffset, LineGridRows);
        this.cells = new Uint8Array(buffer, CellsOffset, PendingCellCapacity);
        this.runs = new Int32Array(buffer, RunsOffset, (PendingRunCapacity + 1) * PendingRunWords);
        this.fb32 = new Int32Array(buffer, FramebufferOffset, framebufferPixels);
        /**
         * Draws the first `runCount` headers, in order, in `palette`.
         * @type {(runCount: number, modeBase: number, pixelsPerChar: number, doubledLines: boolean,
         *     lineGridValue: number) => void}
         */
        this.drain = memory
            ? new WebAssembly.Instance(DrainModule, { env: { memory } }).exports.drain
            : (...args) => jsDrain(this, ...args);
    }
}
