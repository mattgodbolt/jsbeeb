import { decodedPanel, DecodedRegisters, lit, namedBits, register, spelt } from "./decoded-registers.js";
import { Centred, StartEdge } from "./panel-layout.js";
import { Video } from "../video.js";

const MinPanelSize = { w: 240, h: 120 };
const PaletteEntries = 16;
const ColourNames = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const PhysicalColourMask = 7;
const PaletteFlashBit = 8;
const ClockRates = ["1 MHz", "2 MHz"];
const CharactersPerLine = ["10 chars", "20 chars", "40 chars", "80 chars"];
const PixelRatesMhz = [2, 4, 8, 16];
const ClockRatesMhz = [1, 2];
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
        names.push({ name: colour.toString(16), title: `NuLA's colour ${colour.toString(16)} flashes` });
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

/** The palette entry bits that carry a pixel's bits, most significant first, by the colours a mode has. */
const LogicalColourBits = new Map([
    [2, [3]],
    [4, [3, 1]],
    [16, [3, 2, 1, 0]],
]);
const TwoColourPixelsPerByte = 8;
const FourColourPixelsPerByte = 4;

const BypassedPaletteHeading = {
    text: "Palette: bypassed",
    title: "NuLA's direct palette mode gives pixels NuLA's colours by their own number, not through this palette",
};
const TeletextPaletteHeading = {
    text: "Palette: unused by teletext",
    title: "The SAA5050 makes teletext's colours itself; the ULA's palette plays no part",
};
const EntriesHeading = { text: "Palette: 16 entries", title: "Each of the palette's entries, as written" };
const ShowEntries = { text: "entries", title: "Show the palette's sixteen entries" };
const ShowColours = { text: "colours", title: "Show the palette by the colours this mode has" };
const NulaOnHeading = { text: "NuLA palette", title: "" };
const NulaOffHeading = {
    text: "NuLA palette: switched off",
    title: "Register 5 has switched NuLA off: until power off, &FE22 and &FE23 reach the ULA's own registers",
};

const NulaColumn = `
    <div>
        <div class="videoula-nula-registers"></div>
        <div class="decoded-heading videoula-nula-heading"></div>
        <div class="videoula-palette videoula-nula-palette"></div>
    </div>`;

/** How many colours the control register's clock and pixel rate make: 2, 4 or 16. */
function coloursOf(ctrl) {
    const clockMhz = ClockRatesMhz[(ctrl >>> 4) & 1];
    const pixelsPerByte = PixelRatesMhz[(ctrl >>> 2) & 3] / clockMhz;
    if (pixelsPerByte >= TwoColourPixelsPerByte) return 2;
    if (pixelsPerByte === FourColourPixelsPerByte) return 4;
    return 16;
}

/** The palette entries a logical colour is drawn through, in a mode with `colours` colours. */
function entriesOf(logical, colours) {
    const bits = LogicalColourBits.get(colours);
    const entries = [];
    for (let entry = 0; entry < PaletteEntries; ++entry) {
        const matches = bits.every((bit, i) => ((entry >>> bit) & 1) === ((logical >>> (bits.length - 1 - i)) & 1));
        if (matches) entries.push(entry);
    }
    return entries;
}

function entryList(entries) {
    const first = entries[0];
    const last = entries[entries.length - 1];
    if (last - first === entries.length - 1) return `${first.toString(16)}-${last.toString(16)}`;
    return entries.map((entry) => entry.toString(16)).join(",");
}

/** Sixteen slots of a swatch with a label, redrawn only when something changes. An empty slot keeps its room. */
class Swatches {
    /** @param {HTMLElement} container */
    constructor(container) {
        this._container = container;
        this._cells = [];
        for (let slot = 0; slot < PaletteEntries; ++slot) {
            const cell = document.createElement("div");
            cell.className = "videoula-palette-entry";
            const index = document.createElement("span");
            index.className = "videoula-palette-index";
            const swatch = document.createElement("span");
            swatch.className = "videoula-palette-swatch";
            const label = document.createElement("span");
            label.className = "videoula-palette-label";
            const entries = document.createElement("span");
            entries.className = "videoula-palette-entries";
            cell.append(index, swatch, label, entries);
            container.append(cell);
            this._cells.push({ cell, index, swatch, label, entries, shown: "" });
        }
    }

    /**
     * @param {({index: number, colour: string, label: string, entries: string, title: string} | null)[]} slots
     * @param {boolean} dimmed
     */
    update(slots, dimmed) {
        this._container.classList.toggle("dimmed", dimmed);
        for (const [slot, cell] of this._cells.entries()) {
            const shown = slots[slot];
            const key = shown ? Object.values(shown).join("\u0000") : "";
            if (key === cell.shown) continue;
            cell.shown = key;
            cell.cell.classList.toggle("unused", !shown);
            if (!shown) continue;
            cell.index.textContent = shown.index.toString(16);
            cell.swatch.style.background = shown.colour;
            cell.label.textContent = shown.label;
            cell.entries.textContent = shown.entries;
            cell.cell.title = shown.title;
        }
    }
}

/** Each palette entry: its colour now, a short label, and what it is in words. */
function ulaPaletteEntries(video, hasNula) {
    return [...video.actualPal].map((entry, index) => {
        const described = describeEntry(video, hasNula, entry, index);
        return { ...described, title: `Entry ${index.toString(16)}: ${described.what}` };
    });
}

function describeEntry(video, hasNula, entry, index) {
    const colour = physicalColour(entry);
    const flashes = entry & PaletteFlashBit && video.ula.flash[colour];
    const swatch = cssColour(video.ulaPal[index]);
    if (hasNula) {
        // NuLA's colours 8 to 15 need not duplicate 0 to 7, so an entry is named by the NuLA colour it draws.
        const steady = (entry ^ PhysicalColourMask).toString(16);
        const other = entry.toString(16);
        return {
            index,
            colour: swatch,
            label: flashes ? `NuLA ${steady}/${other}` : `NuLA ${steady}`,
            entries: "",
            what: `NuLA's colour ${steady}${flashes ? `, flashing with ${other}` : ""}`,
        };
    }
    const steady = ColourNames[colour];
    const other = ColourNames[colour ^ PhysicalColourMask];
    return {
        index,
        colour: swatch,
        label: flashes ? `${steady}/${other}` : steady,
        entries: "",
        what: `colour ${colour}, ${steady}${flashes ? `, flashing with ${other}` : ""}`,
    };
}

/** The palette by the mode's logical colours, each from the entries that draw it, marked mixed if they disagree. */
function logicalColours(video, entries, colours) {
    const slots = [];
    for (let logical = 0; logical < PaletteEntries; ++logical) {
        if (logical >= colours) {
            slots.push(null);
            continue;
        }
        const drawnBy = entriesOf(logical, colours);
        const [first] = drawnBy;
        const mixed = drawnBy.some((entry) => video.actualPal[entry] !== video.actualPal[first]);
        const list = colours === PaletteEntries ? "" : entryList(drawnBy);
        const title = mixed
            ? `Logical colour ${logical}: its entries disagree. ${drawnBy.map((entry) => entries[entry].title).join("; ")}`
            : `Logical colour ${logical}${list ? `, in entries ${list}` : ""}: ${entries[first].what}`;
        slots.push({
            index: logical,
            colour: entries[first].colour,
            label: mixed ? "mixed" : entries[first].label,
            entries: list,
            title,
        });
    }
    return slots;
}

function nulaPaletteEntries(ula) {
    return [...ula.collook].map((abgr, index) => {
        const flashes = index >= FirstFlashColour && ula.flash[index - FirstFlashColour];
        const rgb = nulaRgb(abgr);
        return {
            index,
            colour: cssColour(abgr),
            label: flashes ? `${rgb} flash` : rgb,
            entries: "",
            title: `NuLA's colour ${index.toString(16)}: red ${rgb[0]}, green ${rgb[1]}, blue ${rgb[2]}${flashes ? ", flashing" : ""}`,
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
    /** Whether the machine has a video ULA to show: the Atom's picture comes from a 6847, and `?fakeVideo` has none. */
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
        this._hasNula = this._video.ula.hasVideoNula;
        this._showEntries = false;
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
                <div class="decoded-heading">
                    <span class="videoula-ula-heading"></span>
                    <button type="button" class="txt-btn videoula-palette-view"></button>
                </div>
                <div class="videoula-palette videoula-ula-palette"></div>
            </div>
            ${this._hasNula ? NulaColumn : ""}`;
        const part = (className) => body.querySelector(`.${className}`);
        this._control = new DecodedRegisters(part("videoula-control"), [ControlSection]);
        this._ulaPalette = new Swatches(part("videoula-ula-palette"));
        this._ulaHeading = part("videoula-ula-heading");
        this._viewButton = part("videoula-palette-view");
        this._viewButton.addEventListener("click", () => {
            this._showEntries = !this._showEntries;
            this.update();
        });
        if (this._hasNula) {
            this._nulaRegisters = new DecodedRegisters(part("videoula-nula-registers"), [NulaSection]);
            this._nulaPalette = new Swatches(part("videoula-nula-palette"));
            this._nulaHeading = part("videoula-nula-heading");
        }
        this.update();
    }

    update() {
        const video = this._video;
        this._control.update({ ctrl: video.ulactrl });
        this._updateUlaPalette();
        if (!this._hasNula) return;
        this._nulaRegisters.update(video.ula);
        this._nulaPalette.update(nulaPaletteEntries(video.ula), false);
        showHeading(this._nulaHeading, video.ula.disabled ? NulaOffHeading : NulaOnHeading);
    }

    _updateUlaPalette() {
        const video = this._video;
        const entries = ulaPaletteEntries(video, this._hasNula);
        const unused = video.ula.paletteMode ? BypassedPaletteHeading : video.teletextMode && TeletextPaletteHeading;
        this._viewButton.classList.toggle("unused", !!unused);
        showHeading(this._viewButton, this._showEntries ? ShowColours : ShowEntries);
        if (unused) {
            showHeading(this._ulaHeading, unused);
            this._ulaPalette.update(entries, true);
            return;
        }
        if (this._showEntries) {
            showHeading(this._ulaHeading, EntriesHeading);
            this._ulaPalette.update(entries, false);
            return;
        }
        const colours = coloursOf(video.ulactrl);
        showHeading(this._ulaHeading, {
            text: `Palette: ${colours} colours`,
            title: "Each of this mode's colours, from the palette entries its pixels select",
        });
        this._ulaPalette.update(logicalColours(video, entries, colours), false);
    }
}
