import { decodedPanel, DecodedRegisters, lit, namedBits, register, spelt } from "./decoded-registers.js";
import { Centred, StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 240, h: 120 };
const PaletteEntries = 16;
const ColourNames = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const PhysicalColourMask = 7;
const PaletteFlashBit = 8;
const ClockRates = ["1 MHz", "2 MHz"];
const CharactersPerLine = ["10 chars", "20 chars", "40 chars", "80 chars"];
const PixelRatesMhz = [2, 4, 8, 16];
const FirstFlashColour = 8;
const FlashFlagsPerRegister = 4;

/** The ULA's palette stores each physical colour's three bits inverted. */
const physicalColour = (entry) => (entry & PhysicalColourMask) ^ PhysicalColourMask;

/** A colour as the video keeps it, 0xAABBGGRR, as CSS. */
function cssColour(abgr) {
    const rgb = ((abgr & 0xff) << 16) | (abgr & 0xff00) | ((abgr >>> 16) & 0xff);
    return `#${rgb.toString(16).padStart(6, "0")}`;
}

/** NuLA's 12-bit colour as its palette register takes it: a hex digit each of red, green and blue. */
function nulaRgb(abgr) {
    return [abgr & 0xff, (abgr >>> 8) & 0xff, (abgr >>> 16) & 0xff].map((gun) => (gun >>> 4).toString(16)).join("");
}

function decodeControl(ctrl) {
    const characters = (ctrl >>> 2) & 3;
    return [
        lit("cursor 1", "Bit 7: the cursor covers its first character", ctrl & 0x80),
        lit("cursor 2", "Bit 6: the cursor covers its second character", ctrl & 0x40),
        lit("cursor 3-4", "Bit 5: the cursor covers its third and fourth characters", ctrl & 0x20),
        spelt(ClockRates[(ctrl >>> 4) & 1], "Bit 4: the 6845's character clock", ClockRates),
        spelt(
            CharactersPerLine[characters],
            `Bits 2 and 3: pixels are shifted out at ${PixelRatesMhz[characters]} MHz`,
            CharactersPerLine,
        ),
        lit("teletext", "Bit 1: the picture comes from the SAA5050 teletext chip", ctrl & 2),
        lit("flash", "Bit 0: flashing colours show their second colour", ctrl & 1),
    ];
}

/** Register 8 or 9: which of NuLA's colours 8 to 11, or 12 to 15, flash, the first of them in bit 3. */
function flashFlagsRegister(number, firstFlag) {
    const value = ({ flash }) => {
        let flags = 0;
        for (let flag = 0; flag < FlashFlagsPerRegister; ++flag) flags = (flags << 1) | flash[firstFlag + flag];
        return flags;
    };
    const names = [];
    for (let flag = FlashFlagsPerRegister - 1; flag >= 0; --flag) {
        const colour = FirstFlashColour + firstFlag + flag;
        names.push({ name: colour.toString(16), title: `NuLA's colour ${colour} flashes` });
    }
    return register(`R${number}`, `Register ${number}: which of NuLA's colours flash`, 8, value, namedBits(names));
}

const ControlSection = {
    heading: "Control",
    registers: [register("CTRL", "&FE20: the video ULA's control register", 8, (s) => s.ctrl, decodeControl)],
};

const NulaSection = {
    heading: "NuLA",
    registers: [
        register(
            "R1",
            "Register 1: the palette mode",
            8,
            (ula) => ula.paletteMode,
            (mode) => [lit("direct", "Pixels take NuLA's colours by number, bypassing the ULA's palette", mode)],
        ),
        flashFlagsRegister(8, 0),
        flashFlagsRegister(9, FlashFlagsPerRegister),
    ],
};

const UlaPaletteHeading = { text: "Palette", title: "" };
const BypassedPaletteHeading = {
    text: "Palette: bypassed",
    title: "NuLA's direct palette mode gives pixels NuLA's colours by their own number, not through this palette",
};
const NulaOnHeading = { text: "NuLA palette", title: "" };
const NulaOffHeading = {
    text: "NuLA palette: switched off",
    title: "Register 5 has switched NuLA off: until power off, &FE22 and &FE23 reach the ULA's own registers",
};

const NulaColumn = `
    <div>
        <div class="nula-registers"></div>
        <div class="decoded-heading nula-palette-heading"></div>
        <div class="videoula-palette nula-palette"></div>
    </div>`;

/** Sixteen colours as swatches, each labelled with what it is, redrawn only when something changes. */
class Swatches {
    /** @param {HTMLElement} container */
    constructor(container) {
        this._cells = [];
        for (let entry = 0; entry < PaletteEntries; ++entry) {
            const cell = document.createElement("div");
            cell.className = "videoula-palette-entry";
            const index = document.createElement("span");
            index.className = "videoula-palette-index";
            index.textContent = entry.toString(16);
            const swatch = document.createElement("span");
            swatch.className = "videoula-palette-swatch";
            const label = document.createElement("span");
            label.className = "videoula-palette-label";
            cell.append(index, swatch, label);
            container.append(cell);
            this._cells.push({ cell, swatch, label, shown: "" });
        }
    }

    /** @param {{colour: string, label: string, title: string}[]} entries */
    update(entries) {
        for (const [entry, { colour, label, title }] of entries.entries()) {
            const cell = this._cells[entry];
            const shown = `${colour}\u0000${label}\u0000${title}`;
            if (shown === cell.shown) continue;
            cell.shown = shown;
            cell.swatch.style.background = colour;
            cell.label.textContent = label;
            cell.cell.title = title;
        }
    }
}

function ulaPaletteEntries(video, hasNula) {
    return [...video.actualPal].map((entry, index) => {
        const colour = physicalColour(entry);
        const flashes = entry & PaletteFlashBit && video.ula.flash[colour];
        const swatch = cssColour(video.ulaPal[index]);
        if (hasNula) {
            // NuLA's colours 8 to 15 need not duplicate 0 to 7, so an entry is named by the NuLA colour it draws.
            const steady = (entry ^ PhysicalColourMask).toString(16);
            const other = entry.toString(16);
            return {
                colour: swatch,
                label: flashes ? `NuLA ${steady}/${other}` : `NuLA ${steady}`,
                title: `Entry ${index}: NuLA's colour ${steady}${flashes ? `, flashing with ${other}` : ""}`,
            };
        }
        const steady = ColourNames[colour];
        const other = ColourNames[colour ^ PhysicalColourMask];
        return {
            colour: swatch,
            label: flashes ? `${steady}/${other}` : steady,
            title: `Entry ${index}: colour ${colour}, ${steady}${flashes ? `, flashing with ${other}` : ""}`,
        };
    });
}

function nulaPaletteEntries(ula) {
    return [...ula.collook].map((abgr, index) => {
        const flashes = index >= FirstFlashColour && ula.flash[index - FirstFlashColour];
        const rgb = nulaRgb(abgr);
        return {
            colour: cssColour(abgr),
            label: flashes ? `${rgb} flash` : rgb,
            title: `NuLA's colour ${index}: red ${rgb[0]}, green ${rgb[1]}, blue ${rgb[2]}${flashes ? ", flashing" : ""}`,
        };
    });
}

function showHeading(node, { text, title }) {
    if (node.textContent === text) return;
    node.textContent = text;
    node.title = title;
}

/**
 * A floating panel showing the video ULA decoded: its control register and its palette as colours, and with a
 * VideoNuLA fitted, NuLA's own palette and the registers that say how it is used.
 */
export class VideoUlaPanel {
    /** Whether the machine has a video ULA to show: the Atom's picture comes from a 6847 instead. */
    static fits(cpu) {
        return !cpu.model.isAtom;
    }

    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     */
    constructor({ cpu, arrangement }) {
        this._video = cpu.video;
        this._hasNula = this._video.ula.hasVideoNula;
        const { floating, body } = decodedPanel({
            id: "videoula",
            title: "Video ULA",
            feature: "video_ula",
            place: () => ({ x: Centred, y: StartEdge }),
            minSize: MinPanelSize,
            arrangement,
            draw: () => this.update(),
        });
        this.floating = floating;
        body.innerHTML = `
            <div>
                <div class="videoula-control"></div>
                <div class="decoded-heading ula-palette-heading"></div>
                <div class="videoula-palette ula-palette"></div>
            </div>
            ${this._hasNula ? NulaColumn : ""}`;
        const part = (className) => body.querySelector(`.${className}`);
        this._control = new DecodedRegisters(part("videoula-control"), [ControlSection]);
        this._ulaPalette = new Swatches(part("ula-palette"));
        this._ulaHeading = part("ula-palette-heading");
        if (this._hasNula) {
            this._nulaRegisters = new DecodedRegisters(part("nula-registers"), [NulaSection]);
            this._nulaPalette = new Swatches(part("nula-palette"));
            this._nulaHeading = part("nula-palette-heading");
        }
        this.update();
    }

    update() {
        const video = this._video;
        this._control.update({ ctrl: video.ulactrl });
        this._ulaPalette.update(ulaPaletteEntries(video, this._hasNula));
        showHeading(this._ulaHeading, video.ula.paletteMode ? BypassedPaletteHeading : UlaPaletteHeading);
        if (!this._hasNula) return;
        this._nulaRegisters.update(video.ula);
        this._nulaPalette.update(nulaPaletteEntries(video.ula));
        showHeading(this._nulaHeading, video.ula.disabled ? NulaOffHeading : NulaOnHeading);
    }
}
