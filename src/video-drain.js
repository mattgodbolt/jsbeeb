// The drain: turns pending bitmap cells, recorded by Video as the beam passes them, into framebuffer pixels; and the
// teletext painter, which does the same for the SAA5050 cells its replay decodes. There are two implementations of
// each, a WebAssembly SIMD function assembled at load and a plain JS one. They work on the same memory and draw the
// same pixels; the Wasm is used wherever the browser can compile it, and the JS otherwise (WebAssembly switched off,
// as in Safari's Lockdown Mode, or a content security policy that forbids compiling it). The JS also documents the
// Wasm: DrawClipped, InvertCursor, DrawCell and DrainCode below pair with the JS functions drawClipped, invertCursor,
// drawCell and jsDrain further down, and PaintClippedTeletextCell, PaintBlackCell, PaintTeletextCell and
// PaintTeletextCode with paintClippedTeletextCell, paintBlackCell, paintTeletextCell and jsPaintTeletext, step for
// step and with the same local names.
//
// THE MEMORY
//
// One block of memory holds everything the drain reads and writes. For the Wasm it is a WebAssembly.Memory created at
// its final size and never grown (growing would detach its ArrayBuffer and every view of it); for the JS it is an
// ArrayBuffer of the same size and layout. Video's fb32, lineGrid, table4bpp and pendingCells, and the SAA5050's
// colour table, are views of it.
//
//   Offset   Size (bytes)                Region
//   0        16384                       table4bpp: for each of the 4 ULA modes and 256 video bytes, the palette
//                                        index (0 to 15) of each of up to 16 pixels, one byte each, so a cell's
//                                        indices are 16 consecutive bytes at (mode << 12) | (byte << 4).
//   16384    64                          palette: 16 colours, each an RGBA word (R in the lowest byte), copied in
//                                        by Video before each drain.
//   16448    1024                        line grid: one byte per framebuffer row, the pixel size it was drawn at
//                                        (see pixel-grid.js); the drain writes it for bitmap runs, the teletext
//                                        painter for teletext cells.
//   17472    262144                      records: up to 65536 pending records, one i32 each.
//   279616   4096                        teletext lanes: for each of the 256 values of a glyph row's byte (four
//                                        pixels, two bits each), 16 swizzle lanes: pixel n's RGBA is bytes
//                                        4 * bits to 4 * bits + 3 of a vector of the cell's four colours.
//   283712   1024                        teletext colour: the SAA5050's 256 colours (see Teletext.rebuildColours),
//                                        RGBA words; a cell's palette index picks four in a row.
//   284736   8192                        teletext cells: up to 1024 cells to paint, two i32s each.
//   292928   32                          drawn boxes: for the even rows, then the odd rows, four i32s bounding
//                                        what was drawn since those rows were last cleared: the first column, one
//                                        past the last, the first row and one past the last (empty is 1024, 0,
//                                        1024, 0). Video's clear blacks out only the box of the rows it clears.
//   292960   4 * framebufferPixels       framebuffer: 1024 RGBA words per row.
//            + 8192                      overrun: room for a doubled cell's second row below the last row, and a
//                                        cell running past the end of its row.
//
// THE RECORDS
//
//   bits 0 to 7    the video byte the cell shows (ignored for a cursor record)
//   bits 8 to 27   the cell's framebuffer offset in pixels, plus one row (1024) so an odd field's row -1 is positive
//   bit 28         set for a cursor record: invert the cell already drawn there, rather than draw a byte
//
// THE ALGORITHM, for each record in order
//
// 1. Decode: `raw` is the record shifted down 8 (the biased offset, and the cursor bit). `start` is the offset with
//    the bias removed, rounded down to an even row when lines are doubled. `source` is where the cell's 16 palette
//    indices are in table4bpp.
// 2. Every record widens the drain's columns, minColumn to maxColumn, by its `start`'s column. At the end, the
//    drain widens both drawn boxes by those columns (plus pixelsPerChar), and by the rows from the first record's
//    to the last's (plus the row below when doubled). Records arrive in beam order, so the first is the top row and
//    the last the bottom one: Video appends them only while bitmapX is within a row, and bitmapY only grows, except
//    at flyback and restore, which drain first. A cell running past the end of its row widens the box to the whole
//    width and the next row; a clipped cell's row is -1 or -2, and it spills onto row 0.
// 3. A negative `start` is a cell on the line above an odd field; only its right end, spilling onto row 0, is drawn,
//    pixel by pixel (drawClipped).
// 4. A cursor record inverts the RGB of the cell's pixels, on both rows when lines are doubled (invertCursor).
// 5. Otherwise it is a cell. Cells that follow on from the previous one (its `raw` plus pixelsPerChar) form a run;
//    the first cell of a run writes the line grid for its row, and for the row below when lines are doubled.
// 6. The cell is drawn (drawCell). The JS looks each pixel's colour up through table4bpp and the palette. The Wasm
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
//
// THE TELETEXT CELLS
//
//   word 0         the glyph row: 16 pixels, two bits each from the lowest, each picking one of the cell's four
//                  colours (background, two blends, foreground); 0 shows only the background
//   word 1         bits 0 to 7: the palette index of the cell's first colour in teletext colour (a multiple of 4)
//                  bit 9: the TTX trick's black cell, 8 black pixels, ignoring the glyph row and palette
//                  bit 10: lines are doubled, so paint the row below as well
//                  bits 11 to 31: the framebuffer offset, signed: the line above an odd field is a negative row
//                  bit 8, the log's shown bit, is set and ignored
//
// The teletext painter, for each cell in order:
// 1. A negative offset is a cell on the line above an odd field; only what spills onto row 0 is painted, pixel by
//    pixel and with no line grid (paintClippedTeletextCell), as for a bitmap cell.
// 2. Otherwise the cell's row, and the row below when lines are doubled, are marked in the line grid.
// 3. A black cell is two stores of four black pixels (paintBlackCell).
// 4. Otherwise one 128-bit load fetches the cell's four colours from teletext colour. For each byte of the glyph row,
//    a load of that byte's teletext lanes and one i8x16.swizzle pick four pixels' colours out of them, and one
//    128-bit store writes them: four swizzles and stores a cell (paintTeletextCell). Each store is made again one row
//    down when lines are doubled.

import { assembleModule } from "./wasm-assembler.js";
import { encodeLineGrid, LineGridRows } from "./video-filters/pixel-grid.js";

export const PendingRowBias = 1;
export const PendingOffsetShift = 8;
export const PendingOffsetMask = 0xfffff;
const PendingByteMask = 0xff;
export const PendingCursor = 1 << 28;
// Flyback drains, and a field records at most 313 lines (bitmapY below 625 in steps of two) of 128
// cells and a few cursor inverts.
const PendingCapacity = 1 << 16;
export const CursorInvert = 0x00ffffff;
export const OPAQUE_BLACK = 0xff000000;

const Table4bppBytes = 4 * 256 * 16;
const PaletteEntries = 16;
const RowShift = 10;
export const RowPixels = 1 << RowShift;
const WordShift = 2;
const WordBytes = 1 << WordShift;
const RowBytes = RowPixels * WordBytes;
const TableRowShift = 4;
const WideCellPixels = 16;
const WasmPageBytes = 65536;

export const TeletextCellCapacity = 1024;
export const TeletextPaletteMask = 0xff;
export const TeletextBlack = 0x200;
export const TeletextDoubled = 0x400;
export const TeletextOffsetShift = 11;
export const TeletextCellWords = 2;
const TeletextCellBytesShift = Math.log2(TeletextCellWords * WordBytes);
export const TeletextCellPixels = 16;
const TeletextBlackPixels = 8;
const TeletextColours = 256;
const VectorBytes = 16;
const GlyphPixelBits = 2;
const GlyphPixelMask = 3;
const GlyphRowByteBits = 8;
const GlyphRowByteMask = 0xff;
const PixelsPerGlyphRowByte = GlyphRowByteBits / GlyphPixelBits;
const TeletextLaneShift = Math.log2(VectorBytes);
const TeletextLaneBytes = (GlyphRowByteMask + 1) << TeletextLaneShift;
// MODE 7 is one texel per pixel: the chip paints each of its 16 texels a cell, at the framebuffer's own resolution.
const LineGridTeletext = encodeLineGrid(1, false);
const LineGridTeletextDoubled = encodeLineGrid(1, true);

const TableOffset = 0;
const PaletteOffset = TableOffset + Table4bppBytes;
const LineGridOffset = PaletteOffset + PaletteEntries * WordBytes;
const RecordsOffset = LineGridOffset + LineGridRows;
const TeletextLanesOffset = RecordsOffset + PendingCapacity * WordBytes;
const TeletextColourOffset = TeletextLanesOffset + TeletextLaneBytes;
const TeletextCellsOffset = TeletextColourOffset + TeletextColours * WordBytes;
const DrawnBoxesOffset = TeletextCellsOffset + TeletextCellCapacity * TeletextCellWords * WordBytes;
const BoxWords = 4;
const BoxBytes = BoxWords * WordBytes;
const FieldParities = 2;
const EmptyBox = [RowPixels, 0, LineGridRows, 0];
const FramebufferOffset = DrawnBoxesOffset + FieldParities * BoxBytes;
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
    column: "i32",
    minColumn: "i32",
    maxColumn: "i32",
    spill: "i32",
    firstRow: "i32",
    endRow: "i32",
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

// A cell on the line above an odd field: start is negative, on row -1, or row -2 when doubling rounds it down to an
// even row. The loops visit the cell's pixels on its row and, when doubled, the row below; only those at or after
// offset 0 (the cell's right end, spilling past the end of row -1 onto row 0) are drawn, one pixel at a time. A cursor
// record inverts them instead. Pairs with drawClipped in JS.
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
                local.get record
                i32.const ${PendingCursor}
                i32.and                 ;; [address, cursor bit]
                if                      ;; a cursor record: invert what is there
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

// Inverts the RGB of the cell's pixels at start, and of those a row below when lines are doubled. Pairs with
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

// Widens word `field` (0 to 3) of the drawn box at boxOffset to take in `local`: the lower of the two when
// `compare` is i32.lt_s, the higher when it is i32.gt_s.
function widenBoxField(boxOffset, field, local, compare) {
    const offset = DrawnBoxesOffset + boxOffset + field * WordBytes;
    return `
        i32.const 0                         ;; [0], the address for the store
        local.get ${local}
        i32.const 0
        i32.load offset=${offset}           ;; [0, ${local}, the box's]
        local.get ${local}
        i32.const 0
        i32.load offset=${offset}
        ${compare}
        select                              ;; [0, whichever wins]
        i32.store offset=${offset}`;
}

// Widens both drawn boxes by the columns minColumn to maxColumn and the rows from the first record's to the last's.
// Pairs with widenByCells in JS.
const WidenBoxes = `
    local.get maxColumn
    local.get pixelsPerChar
    i32.add
    local.tee maxColumn                     ;; maxColumn = one past the last column drawn; [maxColumn]
    i32.const ${RowPixels}
    i32.gt_s
    local.tee spill                         ;; spill = 1 when a cell ran past the end of its row; [spill]
    if                                      ;; it drew from column 0 of the next row, so take in the whole width
        i32.const 0
        local.set minColumn
        i32.const ${RowPixels}
        local.set maxColumn
    end
    local.get start                         ;; [the last record's start]
    i32.const ${RowShift}
    i32.shr_s
    local.get doubledLines
    i32.add
    local.get spill
    i32.add
    i32.const 1
    i32.add
    local.set endRow                        ;; endRow = one past its row, the row below and the spill's row
    i32.const 0
    i32.load offset=${RecordsOffset}
    i32.const ${PendingOffsetShift}
    i32.shr_u
    i32.const ${PendingOffsetMask}
    i32.and
    i32.const ${PendingRowBias * RowPixels}
    i32.sub
    local.get rowMask
    i32.and                                 ;; [the first record's start]
    i32.const ${RowShift}
    i32.shr_s
    local.set firstRow                      ;; firstRow = its row, -1 or -2 for a clipped cell
    ${range(0, FieldParities)
        .map((parity) => {
            const box = parity * BoxBytes;
            return [
                widenBoxField(box, 0, "minColumn", "i32.lt_s"),
                widenBoxField(box, 1, "maxColumn", "i32.gt_s"),
                widenBoxField(box, 2, "firstRow", "i32.lt_s"),
                widenBoxField(box, 3, "endRow", "i32.gt_s"),
            ].join("");
        })
        .join("")}`;

// drain(count, modeBase, pixelsPerChar, doubledLines, lineGridValue): the whole function. Pairs with jsDrain.
const DrainCode = `
    ${SplitPalette}
    i32.const ${RowPixels}
    local.set minColumn                     ;; minColumn = 1024, past every column; maxColumn starts at 0
    i32.const -1
    local.get doubledLines
    i32.const ${RowShift}
    i32.shl                                 ;; [-1, 1024 when doubled, else 0]
    i32.xor
    local.set rowMask                       ;; rowMask = ~1024 when doubled, clearing a row's odd bit, else ~0
    i32.const -1
    local.set expected                      ;; no run yet; no raw is -1
    block                                   ;; br 1 from the loop body leaves this, ending the drain
        loop                                ;; for each record; br 0 from its body is "continue"
            local.get i
            local.get count
            i32.ge_u
            br_if 1                         ;; done when i >= count
            local.get i
            i32.const ${WordShift}
            i32.shl
            i32.load offset=${RecordsOffset}
            local.tee record                ;; record = records[i]; [record]
            i32.const ${PendingOffsetShift}
            i32.shr_u
            local.tee raw                   ;; raw = record >>> 8; [raw]
            i32.const ${PendingOffsetMask}
            i32.and                         ;; [the biased offset]
            i32.const ${PendingRowBias * RowPixels}
            i32.sub                         ;; [the offset]
            local.get rowMask
            i32.and
            local.set start                 ;; start = offset & rowMask
            local.get start
            i32.const ${RowPixels - 1}
            i32.and
            local.tee column                ;; column = start's column; [column]
            local.get minColumn
            local.get column
            local.get minColumn
            i32.lt_u
            select
            local.set minColumn             ;; minColumn = min(column, minColumn)
            local.get column
            local.get maxColumn
            local.get column
            local.get maxColumn
            i32.gt_u
            select
            local.set maxColumn             ;; maxColumn = max(column, maxColumn)
            local.get modeBase
            local.get record
            i32.const ${PendingByteMask}
            i32.and
            i32.const ${TableRowShift}
            i32.shl
            i32.add
            local.set source                ;; source = modeBase + (video byte << 4)
            local.get i
            i32.const 1
            i32.add
            local.set i                     ;; ++i
            local.get start
            i32.const 0
            i32.lt_s
            if                              ;; start < 0: the line above an odd field
                ${DrawClipped}
                i32.const -1
                local.set expected          ;; the next cell starts a run
                br 1                        ;; continue (depth 0 is this if, 1 the loop)
            end
            local.get record
            i32.const ${PendingCursor}
            i32.and
            if                              ;; a cursor record
                ${InvertCursor}
                i32.const -1
                local.set expected
                br 1                        ;; continue
            end
            local.get raw
            local.get expected
            i32.ne
            if                              ;; the first cell of a run: mark its row(s) in the line grid
                local.get start
                i32.const ${RowShift}
                i32.shr_u                   ;; [row]
                local.get lineGridValue
                i32.store8 offset=${LineGridOffset}       ;; lineGrid[row] = lineGridValue
                local.get doubledLines
                if                          ;; and the row below it when lines are doubled
                    local.get start
                    i32.const ${RowShift}
                    i32.shr_u
                    local.get lineGridValue
                    i32.store8 offset=${LineGridOffset + 1}   ;; lineGrid[row + 1] = lineGridValue
                end
            end
            local.get raw
            local.get pixelsPerChar
            i32.add
            local.set expected              ;; expected = raw + pixelsPerChar, where a following cell would be
            local.get start
            i32.const ${WordShift}
            i32.shl
            local.set address               ;; address = start * 4
            ${DrawCell}
            br 0                            ;; continue
        end
    end
    local.get count
    if                                      ;; there were records
        ${WidenBoxes}
    end`;

const PaintTeletextParams = ["count"];
const PaintTeletextLocals = {
    i: "i32",
    record: "i32",
    pixels: "i32",
    info: "i32",
    offset: "i32",
    doubled: "i32",
    row: "i32",
    address: "i32",
    cellPixels: "i32",
    span: "i32",
    pixel: "i32",
    at: "i32",
    rowsEnd: "i32",
    colour: "i32",
    cellColours: "v128",
    pixels0: "v128",
    pixels1: "v128",
    pixels2: "v128",
    pixels3: "v128",
};

// A teletext cell on the line above an odd field: offset is negative. As DrawClipped does for a bitmap cell, it draws
// only the pixels at or after offset 0, one at a time, on the cell's row and the row below when lines are doubled.
// It writes no line grid, since none of the cell's rows is in the framebuffer. Pairs with paintClippedTeletextCell.
const PaintClippedTeletextCell = `
    i32.const ${TeletextCellPixels}
    local.set cellPixels                ;; cellPixels = 16
    local.get info
    i32.const ${TeletextBlack}
    i32.and
    if                                  ;; a black cell is half as wide
        i32.const ${TeletextBlackPixels}
        local.set cellPixels            ;; cellPixels = 8
    end
    i32.const ${RowPixels}
    local.set span                      ;; span = 1024, the pixels from a pixel to below its last row
    local.get doubled
    if
        i32.const ${2 * RowPixels}
        local.set span                  ;; span = 2048 when lines are doubled
    end
    i32.const 0
    local.set pixel                     ;; pixel = 0
    loop                                ;; for each pixel of the cell
        i32.const ${OPAQUE_BLACK}
        local.set colour                ;; colour = OPAQUE_BLACK, for a black cell
        local.get info
        i32.const ${TeletextBlack}
        i32.and
        i32.eqz
        if                              ;; not black: the pixel's colour from the glyph row
            local.get info
            i32.const ${TeletextPaletteMask}
            i32.and                     ;; [the cell's palette index]
            local.get pixels
            local.get pixel
            i32.const ${GlyphPixelBits}
            i32.mul
            i32.shr_u
            i32.const ${GlyphPixelMask}
            i32.and                     ;; [palette, the pixel's two bits]
            i32.add
            i32.const ${WordShift}
            i32.shl
            i32.load offset=${TeletextColourOffset}  ;; [teletextColour[palette + bits]]
            local.set colour
        end
        local.get offset
        local.get pixel
        i32.add
        local.tee at                    ;; at = offset + pixel, on the cell's row; [at]
        local.get span
        i32.add
        local.set rowsEnd               ;; rowsEnd = at + span
        loop                            ;; for at on the cell's row (then the row below when doubled)
            local.get at
            i32.const 0
            i32.ge_s
            if                          ;; only pixels inside the framebuffer
                local.get at
                i32.const ${WordShift}
                i32.shl
                local.get colour
                i32.store offset=${FramebufferOffset}     ;; fb32[at] = colour
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
        local.get cellPixels
        i32.lt_u
        br_if 0                         ;; repeat the outer loop while pixel < cellPixels
    end`;

// Stores the vectors of four pixels named, 16 bytes apart from address, and again a row down when lines are doubled.
function storeTeletextPixels(vectors) {
    const stores = (rowOffset) =>
        vectors
            .map(
                (vector, index) => `
        local.get address
        local.get ${vector}
        v128.store offset=${FramebufferOffset + rowOffset + VectorBytes * index}`,
            )
            .join("");
    return `${stores(0)}
        local.get doubled
        if                                  ;; the same pixels a row down${stores(RowBytes)}
        end`;
}

// The TTX trick's black cell: eight black pixels at address. Pairs with paintBlackCell.
const PaintBlackCell = `
    i32.const ${OPAQUE_BLACK}
    i32x4.splat
    local.set pixels0                       ;; four black pixels
    ${storeTeletextPixels(["pixels0", "pixels0"])}`;

// Picks four pixels' colours, for byte `byte` of the glyph row (pixels 4 * byte to 4 * byte + 3), out of cellColours.
// The byte's lane pattern in TeletextLanes holds, for each of its four pixels, the byte offsets 4 * bits to
// 4 * bits + 3 of the pixel's colour in cellColours.
function fourTeletextPixels(byte) {
    return `
        local.get cellColours                   ;; [the cell's four colours]
        local.get pixels
        i32.const ${GlyphRowByteBits * byte}
        i32.shr_u
        i32.const ${GlyphRowByteMask}
        i32.and                                 ;; [colours, byte ${byte} of the glyph row]
        i32.const ${TeletextLaneShift}
        i32.shl
        v128.load offset=${TeletextLanesOffset} ;; [colours, the byte's lane pattern]
        i8x16.swizzle                           ;; four RGBA pixels
        local.set pixels${byte}`;
}

// A teletext cell: 16 pixels at address, each one of the cell's four colours, the glyph row's two bits choosing.
// Pairs with paintTeletextCell.
const PaintTeletextCell = `
    local.get info
    i32.const ${TeletextPaletteMask}
    i32.and
    i32.const ${WordShift}
    i32.shl
    v128.load offset=${TeletextColourOffset}    ;; [teletextColour[palette] to teletextColour[palette + 3]]
    local.set cellColours                       ;; the background, two blends and the foreground
    ${range(0, 4).map(fourTeletextPixels).join("")}
    ${storeTeletextPixels(["pixels0", "pixels1", "pixels2", "pixels3"])}`;

// paintTeletext(count): the whole function. Pairs with jsPaintTeletext.
const PaintTeletextCode = `
    block                                   ;; br 1 from the loop body leaves this, ending the paint
        loop                                ;; for each cell; br 0 from its body is "continue"
            local.get i
            local.get count
            i32.ge_u
            br_if 1                         ;; done when i >= count
            local.get i
            i32.const ${TeletextCellBytesShift}
            i32.shl
            local.tee record                ;; record = i * 8, the byte address of cell i's two words
            i32.load offset=${TeletextCellsOffset}
            local.set pixels                ;; pixels = the glyph row, two bits a pixel
            local.get record
            i32.load offset=${TeletextCellsOffset + WordBytes}
            local.tee info                  ;; info = the palette index, flags and offset; [info]
            i32.const ${TeletextOffsetShift}
            i32.shr_s
            local.set offset                ;; offset = info >> 11, signed
            local.get info
            i32.const ${TeletextDoubled}
            i32.and
            local.set doubled               ;; doubled = nonzero when lines are doubled
            local.get i
            i32.const 1
            i32.add
            local.set i                     ;; ++i
            local.get offset
            i32.const 0
            i32.lt_s
            if                              ;; offset < 0: the line above an odd field
                ${PaintClippedTeletextCell}
                br 1                        ;; continue (depth 0 is this if, 1 the loop)
            end
            local.get offset
            i32.const ${RowShift}
            i32.shr_u
            local.set row                   ;; row = offset >> 10
            local.get doubled
            if                              ;; mark the cell's two rows in the line grid
                local.get row
                i32.const ${LineGridTeletextDoubled}
                i32.store8 offset=${LineGridOffset}       ;; lineGrid[row] = LineGridTeletextDoubled
                local.get row
                i32.const ${LineGridTeletextDoubled}
                i32.store8 offset=${LineGridOffset + 1}   ;; lineGrid[row + 1] = LineGridTeletextDoubled
            else                            ;; or its one row
                local.get row
                i32.const ${LineGridTeletext}
                i32.store8 offset=${LineGridOffset}       ;; lineGrid[row] = LineGridTeletext
            end
            local.get offset
            i32.const ${WordShift}
            i32.shl
            local.set address               ;; address = offset * 4
            local.get info
            i32.const ${TeletextBlack}
            i32.and
            if                              ;; the TTX trick's black cell
                ${PaintBlackCell}
                br 1                        ;; continue
            end
            ${PaintTeletextCell}
            br 0                            ;; continue
        end
    end`;

const DrainModuleBytes = assembleModule([
    { name: "drain", params: DrainParams, locals: DrainLocals, code: DrainCode },
    { name: "paintTeletext", params: PaintTeletextParams, locals: PaintTeletextLocals, code: PaintTeletextCode },
]);

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

function drawClipped({ fb32, table4bpp, palette }, record, source, start, pixelsPerChar, doubledLines) {
    const span = (Number(doubledLines) + 1) << RowShift;
    for (let pixel = 0; pixel < pixelsPerChar; ++pixel) {
        const rowsEnd = start + pixel + span;
        for (let at = start + pixel; at < rowsEnd; at += RowPixels) {
            if (at < 0) continue;
            fb32[at] = record & PendingCursor ? fb32[at] ^ CursorInvert : palette[table4bpp[source + pixel]];
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

const recordStart = (record, rowMask) =>
    (((record >>> PendingOffsetShift) & PendingOffsetMask) - PendingRowBias * RowPixels) & rowMask;

function widenBoxes(drawnBoxes, minColumn, endColumn, firstRow, endRow) {
    for (let at = 0; at < drawnBoxes.length; at += BoxWords) {
        drawnBoxes[at] = Math.min(drawnBoxes[at], minColumn);
        drawnBoxes[at + 1] = Math.max(drawnBoxes[at + 1], endColumn);
        drawnBoxes[at + 2] = Math.min(drawnBoxes[at + 2], firstRow);
        drawnBoxes[at + 3] = Math.max(drawnBoxes[at + 3], endRow);
    }
}

// Cells of pixelsPerChar pixels starting at columns minColumn to maxColumn, on the rows of firstStart to lastStart.
// Pairs with WidenBoxes.
function widenByCells({ drawnBoxes }, minColumn, maxColumn, firstStart, lastStart, pixelsPerChar, doubledLines) {
    const spill = Number(maxColumn + pixelsPerChar > RowPixels);
    widenBoxes(
        drawnBoxes,
        spill ? 0 : minColumn,
        spill ? RowPixels : maxColumn + pixelsPerChar,
        firstStart >> RowShift,
        (lastStart >> RowShift) + Number(doubledLines) + spill + 1,
    );
}

/**
 * Draws the first `count` records of `views`, in order, in its palette: the JS drain, the same as the Wasm one.
 * @param {{records: Int32Array, fb32: Int32Array, lineGrid: Uint8Array, drawnBoxes: Int32Array,
 *     table4bpp: Uint8Array, palette: Int32Array}} views
 * @param {number} count
 * @param {number} modeBase the table4bpp offset of byte 0 in the ULA mode
 * @param {number} pixelsPerChar
 * @param {boolean} doubledLines
 * @param {number} lineGridValue
 */
export function jsDrain(views, count, modeBase, pixelsPerChar, doubledLines, lineGridValue) {
    const { records, lineGrid } = views;
    const rowMask = ~(Number(doubledLines) << RowShift);
    let expected = -1;
    let minColumn = RowPixels;
    let maxColumn = 0;
    for (let i = 0; i < count;) {
        const record = records[i];
        const raw = record >>> PendingOffsetShift;
        const start = recordStart(record, rowMask);
        const source = modeBase + ((record & PendingByteMask) << TableRowShift);
        ++i;
        const column = start & (RowPixels - 1);
        minColumn = Math.min(column, minColumn);
        maxColumn = Math.max(column, maxColumn);
        if (start < 0) {
            drawClipped(views, record, source, start, pixelsPerChar, doubledLines);
            expected = -1;
            continue;
        }
        if (record & PendingCursor) {
            invertCursor(views, start, pixelsPerChar, doubledLines);
            expected = -1;
            continue;
        }
        if (raw !== expected) {
            lineGrid[start >>> RowShift] = lineGridValue;
            if (doubledLines) lineGrid[(start >>> RowShift) + 1] = lineGridValue;
        }
        expected = raw + pixelsPerChar;
        drawCell(views, source, start, pixelsPerChar, doubledLines);
    }
    if (count === 0) return;
    const firstStart = recordStart(records[0], rowMask);
    const lastStart = recordStart(records[count - 1], rowMask);
    widenByCells(views, minColumn, maxColumn, firstStart, lastStart, pixelsPerChar, doubledLines);
}

function paintClippedTeletextCell({ fb32, teletextColour }, pixels, info, offset, doubled) {
    const cellPixels = info & TeletextBlack ? TeletextBlackPixels : TeletextCellPixels;
    const span = doubled ? 2 * RowPixels : RowPixels;
    for (let pixel = 0; pixel < cellPixels; ++pixel) {
        const colour =
            info & TeletextBlack
                ? OPAQUE_BLACK
                : teletextColour[
                      (info & TeletextPaletteMask) + ((pixels >>> (pixel * GlyphPixelBits)) & GlyphPixelMask)
                  ];
        const rowsEnd = offset + pixel + span;
        for (let at = offset + pixel; at < rowsEnd; at += RowPixels) {
            if (at >= 0) fb32[at] = colour;
        }
    }
}

function paintBlackCell(fb32, offset, doubled) {
    const end = offset + (doubled ? RowPixels : 0) + TeletextBlackPixels;
    for (let rowStart = offset; rowStart < end; rowStart += RowPixels) {
        for (let pixel = 0; pixel < TeletextBlackPixels; ++pixel) fb32[rowStart + pixel] = OPAQUE_BLACK;
    }
}

function paintTeletextCell(fb32, teletextColour, pixels, info, offset, doubled) {
    const palette = info & TeletextPaletteMask;
    for (let pixel = 0; pixel < TeletextCellPixels; ++pixel) {
        fb32[offset + pixel] = teletextColour[palette + (pixels & GlyphPixelMask)];
        pixels >>>= GlyphPixelBits;
    }
    if (doubled) {
        for (let pixel = offset; pixel < offset + TeletextCellPixels; ++pixel) fb32[pixel + RowPixels] = fb32[pixel];
    }
}

/**
 * Paints the first `count` SAA5050 cells of `views`, in order: the JS teletext painter, the same as the Wasm one.
 * @param {{teletextCells: Int32Array, teletextColour: Int32Array, fb32: Int32Array, lineGrid: Uint8Array}} views
 * @param {number} count
 */
export function jsPaintTeletext(views, count) {
    const { teletextCells, teletextColour, fb32, lineGrid } = views;
    for (let i = 0; i < count; ++i) {
        const pixels = teletextCells[TeletextCellWords * i];
        const info = teletextCells[TeletextCellWords * i + 1];
        const offset = info >> TeletextOffsetShift;
        const doubled = info & TeletextDoubled;
        if (offset < 0) {
            paintClippedTeletextCell(views, pixels, info, offset, doubled);
            continue;
        }
        const row = offset >>> RowShift;
        if (doubled) {
            lineGrid[row] = LineGridTeletextDoubled;
            lineGrid[row + 1] = LineGridTeletextDoubled;
        } else {
            lineGrid[row] = LineGridTeletext;
        }
        if (info & TeletextBlack) {
            paintBlackCell(fb32, offset, doubled);
            continue;
        }
        paintTeletextCell(fb32, teletextColour, pixels, info, offset, doubled);
    }
}

// For each byte of a glyph row, four two-bit pixels, the lanes that pick each pixel's RGBA bytes out of a vector of
// its cell's four colours.
function fillTeletextLanes(lanes) {
    for (let byte = 0; byte < lanes.length >> TeletextLaneShift; ++byte) {
        for (let pixel = 0; pixel < PixelsPerGlyphRowByte; ++pixel) {
            const colourByte = ((byte >>> (pixel * GlyphPixelBits)) & GlyphPixelMask) << WordShift;
            for (let channel = 0; channel < WordBytes; ++channel)
                lanes[(byte << TeletextLaneShift) + pixel * WordBytes + channel] = colourByte + channel;
        }
    }
}

/**
 * The memory the bitmap and teletext renderers work in, holding the framebuffer, the line grid, the pending
 * records, table4bpp, the palette and the SAA5050's colours, cells and lanes, with the drain that draws the records
 * and the painter that paints the cells. The memory never grows, so views of it stay valid.
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
        this.records = new Int32Array(buffer, RecordsOffset, PendingCapacity);
        this.fb32 = new Int32Array(buffer, FramebufferOffset, framebufferPixels);
        this.drawnBoxes = new Int32Array(buffer, DrawnBoxesOffset, FieldParities * BoxWords);
        this.markAllDrawn();
        this.teletextColour = new Int32Array(buffer, TeletextColourOffset, TeletextColours);
        this.teletextCells = new Int32Array(buffer, TeletextCellsOffset, TeletextCellCapacity * TeletextCellWords);
        fillTeletextLanes(new Uint8Array(buffer, TeletextLanesOffset, TeletextLaneBytes));
        const exports = memory ? new WebAssembly.Instance(DrainModule, { env: { memory } }).exports : null;
        /**
         * Draws the first `count` records, in order, in `palette`.
         * @type {(count: number, modeBase: number, pixelsPerChar: number, doubledLines: boolean,
         *     lineGridValue: number) => void}
         */
        this.drain = exports ? exports.drain : (...args) => jsDrain(this, ...args);
        /**
         * Paints the first `count` cells of teletextCells, in order, in teletextColour.
         * @type {(count: number) => void}
         */
        const paintTeletext = exports ? exports.paintTeletext : (count) => jsPaintTeletext(this, count);
        this.paintTeletext = (count) => {
            this.markAllDrawn();
            paintTeletext(count);
        };
    }

    /** Widens the drawn boxes to the whole framebuffer, for writers that do not track what they draw. */
    markAllDrawn() {
        widenBoxes(this.drawnBoxes, 0, RowPixels, 0, this.fb32.length >>> RowShift);
    }

    /**
     * Widens the drawn boxes by `pixels` pixels from `offset`, and the row below when doubled.
     * @param {number} offset
     * @param {number} pixels
     * @param {boolean} doubledLines
     */
    markDrawn(offset, pixels, doubledLines) {
        const column = offset & (RowPixels - 1);
        widenByCells(this, column, column, offset, offset, pixels, doubledLines);
    }

    /**
     * Blacks out what was drawn on the rows of one field parity (even or odd) since they were last cleared, and
     * empties that parity's box.
     * @param {number} parity
     */
    clearDrawn(parity) {
        const box = this.drawnBoxes.subarray(parity * BoxWords, (parity + 1) * BoxWords);
        const [minColumn, endColumn, firstRow, endRow] = box;
        const fromRow = Math.max(firstRow, 0);
        for (let row = fromRow + ((fromRow ^ parity) & 1); row < endRow; row += FieldParities) {
            this.fb32.fill(OPAQUE_BLACK, (row << RowShift) + minColumn, (row << RowShift) + endColumn);
        }
        box.set(EmptyBox);
    }
}
