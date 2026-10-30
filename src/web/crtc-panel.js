import { hexword } from "../hex.js";
import { HDISPENABLE, VDISPENABLE, Video } from "../video.js";
import { decodedPanel, DecodedRegisters, lit, register, spelt } from "./decoded-registers.js";
import { MenuGroup } from "./floating-panel.js";
import { Centred, StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 240, h: 120 };
const ScreenEnd = 0x8000;
const HwScrollUnit = 0x800;
const TeletextBit = 0x2000;
const HwScrollBit = 0x1000;
const ModelBTeletextQuirkBit = 0x800;
const TeletextOffsetBits = 0x3ff;
const TeletextScreen = 0x7c00;
const ModelBTeletextQuirkScreen = 0x3c00;
const RowAddressBits = 0x07;
const MemoryAddressBits = 0x7fff;
const InterlaceSyncAndVideo = 3;

const InterlaceModes = ["no interlace", "interlace sync", "no interlace", "interlace sync and video"];
const DisplaySkews = ["display delay 0", "display delay 1", "display delay 2", "display off"];
const CursorSkews = ["cursor delay 0", "cursor delay 1", "cursor delay 2", "cursor off"];
const CursorBlinks = ["cursor steady", "cursor hidden", "cursor blinks fast", "cursor blinks slow"];
const CursorBlinkTitles = [
    "Bits 5 and 6: the cursor shows in every field",
    "Bits 5 and 6: the cursor never shows",
    "Bits 5 and 6: the cursor blinks, on for 8 fields and off for 8",
    "Bits 5 and 6: the cursor blinks, on for 16 fields and off for 16",
];

/**
 * Where in the BBC's memory the 6845's memory address `ma` reads on row address `rowAddress`: MA13 picks teletext's
 * 1K, and otherwise addresses from &8000 wrap back by the screen size IC32 sets. readVideoMem in video.js does the
 * same on the machine's every read; tests/unit/test-crtc-panel.js holds the two to agreeing.
 */
export function screenAddress(ma, rowAddress, { screenSubtract, isMaster }) {
    if (ma & TeletextBit) {
        return (
            (ma & TeletextOffsetBits) |
            (ma & ModelBTeletextQuirkBit || isMaster ? TeletextScreen : ModelBTeletextQuirkScreen)
        );
    }
    let high = (ma >>> 8) & 0x0f;
    if (ma & HwScrollBit) high = (high - screenSubtract) & 0x0f;
    return ((high << 11) | ((ma & 0xff) << 3) | (rowAddress & RowAddressBits)) & MemoryAddressBits;
}

/** Wide enough for the longest text a count can take, so that the panel keeps its size. */
const counted = (text, title, longest) => spelt(text, title, [longest]);

function bbcAddress(what, ma, state) {
    const address = `&${hexword(screenAddress(ma, 0, state))}`;
    if (ma & TeletextBit) return counted(`${what} ${address}`, "MA13 set: teletext's 1K of memory", `${what} &7c00`);
    const wrapTo = ScreenEnd - state.screenSubtract * HwScrollUnit;
    return counted(
        `${what} ${address}`,
        `Eight bytes a character, from MA × 8; past &8000 it wraps back to &${hexword(wrapTo)}, ` +
            "as IC32's screen size bits set",
        `${what} &7c00`,
    );
}

function decodeHorizontalTotal(r0, { halfClock }) {
    const chars = r0 + 1;
    const micros = halfClock ? chars : chars / 2;
    return [
        counted(
            `${chars} chars, ${micros} µs`,
            `A line is R0 + 1 characters, at ${halfClock ? 1 : 2} MHz as the video ULA sets`,
            "256 chars, 127.5 µs",
        ),
    ];
}

function decodeSyncWidths(r3) {
    const vsync = r3 >>> 4 || 16;
    return [
        counted(`hsync ${r3 & 0x0f} chars`, "Bits 0 to 3: the horizontal sync's width in characters", "hsync 15 chars"),
        counted(
            `vsync ${vsync} lines`,
            "Bits 4 to 7: the vertical sync's width in scanlines, 0 for 16",
            "vsync 16 lines",
        ),
    ];
}

const interlacedVideo = ({ regs }) => (regs[8] & 3) === InterlaceSyncAndVideo;
const linesPerRow = (state) => (interlacedVideo(state) ? (state.regs[9] >>> 1) + 1 : state.regs[9] + 1);
/** Interlaced sync and video, R9 is two less than the row's scanlines across both fields (the 6845's datasheet). */
const rowLines = (state) => (interlacedVideo(state) ? state.regs[9] + 2 : state.regs[9] + 1);

function decodeVerticalTotal(r4, state) {
    const lines = (r4 + 1) * linesPerRow(state) + state.regs[5];
    return [
        counted(
            `${r4 + 1} rows, ${lines} lines`,
            "R4 + 1 rows of characters; with R5's adjust, the scanlines in a field, and half a line more interlaced",
            "128 rows, 4127 lines",
        ),
    ];
}

function decodeScanlinesPerRow(r9, state) {
    const lines = rowLines(state);
    if (!interlacedVideo(state)) return [counted(`${lines} lines`, "R9 + 1 scanlines a row", "33 lines, 16 a field")];
    return [
        counted(
            `${lines} lines, ${linesPerRow(state)} a field`,
            "R9 + 2 scanlines a row, interlaced sync and video showing alternate ones in each field",
            "33 lines, 16 a field",
        ),
    ];
}

function decodeR8(r8) {
    return [
        spelt(InterlaceModes[r8 & 3], "Bits 0 and 1: the interlace mode", InterlaceModes),
        spelt(DisplaySkews[(r8 >>> 4) & 3], "Bits 4 and 5: display enable, delayed in characters", DisplaySkews),
        spelt(CursorSkews[r8 >>> 6], "Bits 6 and 7: the cursor, delayed in characters", CursorSkews),
    ];
}

function decodeCursorStart(r10, { cursorOnThisFrame }) {
    const blink = (r10 >>> 5) & 3;
    return [
        counted(`from line ${r10 & 0x1f}`, "Bits 0 to 4: the cursor's first scanline in its row", "from line 31"),
        spelt(CursorBlinks[blink], CursorBlinkTitles[blink], CursorBlinks),
        lit("shown", "The blink has the cursor shown in this field", cursorOnThisFrame),
    ];
}

function decodeScreenStart(ma, state) {
    const wrapped = !(ma & TeletextBit) && !!(ma & HwScrollBit);
    return [bbcAddress("at", ma, state), lit("wrapped", "Past &8000, so wrapped back by IC32's screen size", wrapped)];
}

function decodeCharacter(c0, { regs, inHSync, dispEnabled }) {
    return [
        counted(`char ${c0} of ${regs[0] + 1}`, "Characters into the line, counting to R0", "char 255 of 256"),
        lit("displayed", "Before R1: the line's displayed part", dispEnabled & HDISPENABLE),
        lit("hsync", "In horizontal sync", inHSync),
    ];
}

function decodeScanline(c9, state) {
    const { regs, evenField, rowAddress } = state;
    return [
        counted(
            `line ${rowAddress} of ${rowLines(state)}`,
            "Scanlines into the row, as the row address on the RA pins: C9, and under interlaced sync and video, " +
                "the frame count's bit 0, which moves on to the next field's at R6",
            "line 31 of 33",
        ),
        lit(
            "odd field",
            "Interlaced, and the odd field, whose scanlines sit between the even field's",
            regs[8] & 1 && !evenField,
        ),
    ];
}

function decodeRow(c4, { regs, dispEnabled, inVSync, inVertAdjust, inDummyRaster }) {
    return [
        counted(`row ${c4} of ${regs[4] + 1}`, "Rows into the field, counting to R4", "row 127 of 128"),
        lit("displayed", "Before R6: the field's displayed rows", dispEnabled & VDISPENABLE),
        lit("vsync", "In vertical sync", inVSync),
        lit("adjust", "In R5's vertical adjust, after the last row", inVertAdjust),
        lit("dummy", "In the extra scanline interlace adds to the even field", inDummyRaster),
    ];
}

function decodeAddress(ma, state) {
    const reads = `&${hexword(screenAddress(ma, state.rowAddress, state))}`;
    return [
        counted(`reads ${reads}`, "The byte the 6845 has the video read now, on this scanline", "reads &7c00"),
        bbcAddress("row", state.lineStartAddr, state),
    ];
}

const pair = (high) => (s) => (s.regs[high] << 8) | s.regs[high + 1];

const Sections = {
    horizontal: {
        heading: "Horizontal",
        registers: [
            register("R0", "Horizontal total, less one", 8, (s) => s.regs[0], decodeHorizontalTotal),
            register(
                "R1",
                "Horizontal displayed",
                8,
                (s) => s.regs[1],
                (r1) => [counted(`${r1} chars shown`, "Characters displayed a line", "255 chars shown")],
            ),
            register(
                "R2",
                "Horizontal sync position",
                8,
                (s) => s.regs[2],
                (r2) => [
                    counted(`hsync at char ${r2}`, "The character the horizontal sync starts on", "hsync at char 255"),
                ],
            ),
            register("R3", "Sync widths", 8, (s) => s.regs[3], decodeSyncWidths),
        ],
    },
    vertical: {
        heading: "Vertical",
        registers: [
            register("R4", "Vertical total, less one", 8, (s) => s.regs[4], decodeVerticalTotal),
            register(
                "R5",
                "Vertical total adjust",
                8,
                (s) => s.regs[5],
                (r5) => [counted(`${r5} lines more`, "Scanlines added after the last row", "31 lines more")],
            ),
            register(
                "R6",
                "Vertical displayed",
                8,
                (s) => s.regs[6],
                (r6) => [counted(`${r6} rows shown`, "Rows of characters displayed", "127 rows shown")],
            ),
            register(
                "R7",
                "Vertical sync position",
                8,
                (s) => s.regs[7],
                (r7) => [counted(`vsync at row ${r7}`, "The row the vertical sync starts on", "vsync at row 127")],
            ),
            register("R9", "Scanlines a row, less one", 8, (s) => s.regs[9], decodeScanlinesPerRow),
        ],
    },
    counters: {
        heading: "Counters",
        registers: [
            register("C0", "The character counter", 8, (s) => s.horizCounter, decodeCharacter),
            register("C9", "The scanline counter", 8, (s) => s.scanlineCounter, decodeScanline),
            register("C4", "The row counter", 8, (s) => s.vertCounter, decodeRow),
            register("MA", "The memory address", 16, (s) => s.addr, decodeAddress),
        ],
    },
    screen: {
        heading: "Screen and cursor",
        registers: [
            register("R8", "Interlace and skew", 8, (s) => s.regs[8], decodeR8),
            register("R12/13", "Screen start address", 16, pair(12), decodeScreenStart),
            register("R10", "Cursor start", 8, (s) => s.regs[10], decodeCursorStart),
            register(
                "R11",
                "Cursor end",
                8,
                (s) => s.regs[11],
                (r11) => [counted(`to line ${r11}`, "The cursor's last scanline in its row", "to line 31")],
            ),
            register("R14/15", "Cursor address", 16, pair(14), (ma, s) => [bbcAddress("at", ma, s)]),
            register("R16/17", "Light pen address, as last strobed", 16, pair(16), (ma, s) => [
                bbcAddress("at", ma, s),
            ]),
        ],
    },
};

/** @param {import("../video.js").Video} video */
function crtcState(video) {
    return {
        regs: video.regs,
        halfClock: video.halfClock,
        screenSubtract: video.screenSubtract,
        isMaster: video.isMaster,
        horizCounter: video.horizCounter,
        scanlineCounter: video.scanlineCounter,
        vertCounter: video.vertCounter,
        addr: video.addr,
        lineStartAddr: video.lineStartAddr,
        rowAddress: video.externalRowAddress(),
        dispEnabled: video.dispEnabled,
        inHSync: video.inHSync,
        inVSync: video.inVSync,
        inVertAdjust: video.inVertAdjust,
        inDummyRaster: video.inDummyRaster,
        evenField: video.doEvenFrameLogic,
        cursorOnThisFrame: video.cursorOnThisFrame,
    };
}

/** A floating panel showing the 6845 CRTC decoded: its registers by what they set, and where its counters are. */
export class CrtcPanel {
    /** Whether the machine has a 6845 to show: the Atom's video is a 6847, and `?fakeVideo` has none at all. */
    static fits(cpu) {
        return !cpu.model.isAtom && cpu.video instanceof Video;
    }

    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     */
    constructor({ cpu, arrangement }) {
        this._video = cpu.video;
        const { floating, body } = decodedPanel({
            id: "crtc",
            title: "6845 CRTC",
            menuGroup: MenuGroup.hardware,
            feature: "crtc",
            place: () => ({ x: Centred, y: StartEdge }),
            minSize: MinPanelSize,
            arrangement,
            draw: () => this.update(),
        });
        this.floating = floating;
        body.innerHTML = `<div class="crtc-timing"></div><div class="crtc-screen"></div>`;
        this._registers = [
            new DecodedRegisters(body.querySelector(".crtc-timing"), [Sections.horizontal, Sections.vertical]),
            new DecodedRegisters(body.querySelector(".crtc-screen"), [Sections.counters, Sections.screen]),
        ];
        this.update();
    }

    update() {
        const state = crtcState(this._video);
        for (const registers of this._registers) registers.update(state);
    }
}
