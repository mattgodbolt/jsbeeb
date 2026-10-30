import { hexword } from "../hex.js";
import { BBC } from "../keymap.js";
import { HwScrollSubtract } from "../video.js";
import { setText } from "./dom-utils.js";
import { decodedPanel, DecodedRegisters, fixed, lit, register, spelt, widest } from "./decoded-registers.js";
import { Centred, StartEdge } from "./panel-layout.js";
import { controlSection, portsSection, TimersSection, viaState } from "./via-registers.js";

// The keypad's columns, 10 to 12, are scanned on a B as well, and the host's keypad reaches them.
const MatrixColumns = 13;
const MatrixRows = 8;
const MinPanelSize = { w: 240, h: 120 };
const StatusForms = ["Autoscan: column 15, no keys", "Port A: column 15, row 7"];
const ScreenEnd = 0x8000;
const HwScrollUnit = 0x800;

/** @type {import("./via-registers.js").ViaWiring} */
const Wiring = {
    ca1: { name: "CA1", wiring: "vsync", title: "the 6845's vertical sync" },
    ca2: {
        name: "CA2",
        wiring: "keyboard",
        title: "the keyboard: a key held as the autoscan passes it, or the key port A selects",
    },
    cb1: { name: "CB1", wiring: "ADC", title: "the analogue to digital converter's end of conversion" },
    cb2: { name: "CB2", wiring: "light pen", title: "the 6845's light pen strobe" },
    t1: "Timer 1 has reached zero; the OS runs it at 100 Hz",
};

const KeyLabels = {
    SEMICOLON_PLUS: ";",
    MINUS: "-",
    LEFT_SQUARE_BRACKET: "[",
    RIGHT_SQUARE_BRACKET: "]",
    COMMA: ",",
    PERIOD: ".",
    SLASH: "/",
    SHIFTLOCK: "SLk",
    TAB: "Tab",
    RETURN: "Ret",
    DELETE: "Del",
    COPY: "Cpy",
    SHIFT: "Shf",
    ESCAPE: "Esc",
    CTRL: "Ctl",
    CAPSLOCK: "CLk",
    LEFT: "←",
    UP: "↑",
    RIGHT: "→",
    DOWN: "↓",
    SPACE: "Spc",
    UNDERSCORE_POUND: "_",
    AT: "@",
    COLON_STAR: ":",
    PIPE_BACKSLASH: "\\",
    HAT_TILDE: "^",
    NUMPADPLUS: "k+",
    NUMPADMINUS: "k-",
    NUMPADSLASH: "k/",
    NUMPADASTERISK: "k*",
    NUMPADHASH: "k#",
    NUMPAD_DELETE: "kDl",
    NUMPADCOMMA: "k,",
    NUMPAD_DECIMAL_POINT: "k.",
    NUMPADENTER: "kRt",
};

function keyLabel(name) {
    return KeyLabels[name] ?? name.replace(/^K(\d)$/, "$1").replace(/^NUMPAD(\d)$/, "k$1");
}

function keyTitle(name) {
    return name
        .replace(/^K(\d)$/, "$1")
        .replace(/^NUMPAD_?/, "keypad ")
        .replaceAll("_", " ")
        .toLowerCase();
}

/** The BBC key at each place in the matrix, by `column,row`. */
const KeysByPlace = new Map(
    Object.entries(BBC).map(([name, [column, row]]) => [
        `${column},${row}`,
        { label: keyLabel(name), title: keyTitle(name) },
    ]),
);

/** A line the B and Master wire differently, in a slot that fits either, so the panel lays out alike on both. */
function wiredAs(isMaster, [bText, bTitle, onB], [masterText, masterTitle, onMaster]) {
    const width = widest([bText, masterText]);
    return isMaster
        ? { text: masterText, title: masterTitle, lit: !!onMaster, width }
        : { text: bText, title: bTitle, lit: !!onB, width };
}

const KeyboardModes = ["keys: autoscan", "keys: port A"];
const ScreenSizes = HwScrollSubtract.map((subtract) => `screen ${(subtract * HwScrollUnit) / 1024}K`);
const KeySelections = ["column 15, row 7"];

function keyboardSelection(portA) {
    return { column: portA & 0xf, row: (portA >>> 4) & 7 };
}

function decodeIc32(ic32, { isMaster }) {
    const scroll = (ic32 >>> 4) & 3;
    const wrapTo = ScreenEnd - HwScrollSubtract[scroll] * HwScrollUnit;
    return [
        lit("sound write", "B0, active low: the sound chip takes the slow data bus", !(ic32 & 1)),
        wiredAs(
            isMaster,
            ["speech read", "B1, active low: the speech processor's read select", !(ic32 & 2)],
            ["RTC read", "B1: the real-time clock's read/write line, high to read", ic32 & 2],
        ),
        wiredAs(
            isMaster,
            ["speech write", "B2, active low: the speech processor's write select", !(ic32 & 4)],
            ["RTC data", "B2: the real-time clock's data strobe", ic32 & 4],
        ),
        spelt(
            KeyboardModes[ic32 & 8 ? 0 : 1],
            "B3, the keyboard's write enable: high, the keyboard scans itself and raises CA2 for a key held; " +
                "low, port A reads the key it selects",
            KeyboardModes,
        ),
        spelt(
            ScreenSizes[scroll],
            `B4 and B5 (C0 and C1): the hardware scroll wraps screen addresses at &${hexword(ScreenEnd)} ` +
                `back to &${hexword(wrapTo)}`,
            ScreenSizes,
        ),
        lit("caps lock", "B6, active low: the caps lock light", !(ic32 & 0x40)),
        lit("shift lock", "B7, active low: the shift lock light", !(ic32 & 0x80)),
    ];
}

function decodePortA(pins, { ic32 }) {
    if (ic32 & 8) return [];
    const { column, row } = keyboardSelection(pins);
    return [
        spelt(
            `column ${column}, row ${row}`,
            "PA0-PA3 and PA4-PA6: the key the keyboard is asked about",
            KeySelections,
        ),
        lit("key down", "PA7: the keyboard pulls it low unless the selected key is held", pins & 0x80),
    ];
}

function decodePortB(pins, { isMaster }) {
    return [
        fixed(
            `latch B${pins & 7} = ${(pins >>> 3) & 1}`,
            "PB0-PB2 address an IC32 latch bit and PB3 is the level written to it",
        ),
        lit("fire 1", "PB4, active low: joystick 1's fire button", !(pins & 0x10)),
        lit("fire 2", "PB5, active low: joystick 2's fire button", !(pins & 0x20)),
        wiredAs(
            isMaster,
            ["speech ready", "PB6, active low: the speech processor is ready", !(pins & 0x40)],
            ["RTC enable", "PB6: the real-time clock's chip enable", pins & 0x40],
        ),
        wiredAs(
            isMaster,
            ["speech IRQ", "PB7, active low: the speech processor's interrupt", !(pins & 0x80)],
            ["RTC address", "PB7: the real-time clock's address strobe", pins & 0x80],
        ),
    ];
}

const Ic32Section = {
    heading: "IC32 latch",
    registers: [register("IC32", "The addressable latch port B writes", 8, (s) => s.ic32, decodeIc32)],
};

const Sections = {
    ports: portsSection({
        a: { title: "Port A's lines: the slow data bus", decode: decodePortA },
        b: { title: "Port B's lines", decode: decodePortB },
    }),
    control: controlSection(Wiring),
};

/**
 * The system VIA and its keyboard as the panel shows them; see viaState.
 * @param {import("../via.js").SysVia} via
 */
export function sysViaState(via) {
    return {
        ...viaState(via),
        ic32: via.IC32,
        isMaster: !!via.isMaster,
        keys: via.keys,
        scanColumn: via.scanColumn(),
    };
}

/** The keyboard's matrix of keys, with those held and the column being scanned or read marked. */
class KeyMatrix {
    constructor(container, status) {
        this._status = status;
        status.style.width = `${widest(StatusForms)}ch`;
        const table = document.createElement("table");
        const header = table.createTHead().insertRow();
        header.append(document.createElement("th"));
        this._headers = [];
        for (let column = 0; column < MatrixColumns; ++column) {
            const th = document.createElement("th");
            th.textContent = String(column);
            header.append(th);
            this._headers.push(th);
        }
        const body = table.createTBody();
        this._cells = [];
        for (let row = 0; row < MatrixRows; ++row) {
            const tr = body.insertRow();
            const th = document.createElement("th");
            th.textContent = String(row);
            tr.append(th);
            for (let column = 0; column < MatrixColumns; ++column) {
                const cell = tr.insertCell();
                const key = KeysByPlace.get(`${column},${row}`);
                cell.textContent = key?.label ?? "";
                cell.title = `${key ? `${key.title}: ` : ""}column ${column}, row ${row}`;
                this._cells.push({ cell, column, row });
            }
        }
        container.replaceChildren(table);
    }

    update({ keys, ic32, portA, scanColumn }) {
        const autoscan = !!(ic32 & 8);
        const selected = keyboardSelection(portA);
        const column = autoscan ? scanColumn : selected.column;
        for (const [index, header] of this._headers.entries()) header.classList.toggle("scanned", index === column);
        for (const { cell, column: c, row } of this._cells) {
            cell.classList.toggle("held", !!keys[c][row]);
            cell.classList.toggle("selected", !autoscan && c === selected.column && row === selected.row);
        }
        const status = autoscan
            ? `Autoscan: column ${scanColumn}${scanColumn >= MatrixColumns ? ", no keys" : ""}`
            : `Port A: column ${selected.column}, row ${selected.row}`;
        setText(this._status, status);
    }
}

/**
 * A floating panel showing the system VIA decoded, with the keyboard matrix beside it, read once a frame while it is
 * open and the machine runs, and not at all while it is closed.
 */
export class SysViaPanel {
    /** Whether the machine has a system VIA to show: the Atom's CPU carries one it never wires up. */
    static fits(cpu) {
        return !cpu.model.isAtom;
    }

    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     */
    constructor({ cpu, arrangement }) {
        this._via = cpu.sysvia;
        const { floating, body, part } = decodedPanel({
            id: "sysvia",
            title: "System VIA",
            feature: "system_via",
            place: () => ({ x: Centred, y: StartEdge }),
            minSize: MinPanelSize,
            arrangement,
            draw: () => this.update(),
        });
        this.floating = floating;
        body.innerHTML = `
            <div class="sysvia-ports"></div>
            <div>
                <div class="decoded-heading">Keyboard</div>
                <div class="key-matrix"></div>
                <div class="key-matrix-status"></div>
                <div class="sysvia-latch"></div>
            </div>`;
        // The keyboard matrix heads the second column, which is why the sections are split as they are.
        this._registers = [
            new DecodedRegisters(part("sysvia-ports"), [Sections.ports, Sections.control]),
            new DecodedRegisters(part("sysvia-latch"), [Ic32Section, TimersSection]),
        ];
        this._matrix = new KeyMatrix(part("key-matrix"), part("key-matrix-status"));
        this.update();
    }

    update() {
        const state = sysViaState(this._via);
        for (const registers of this._registers) registers.update(state);
        this._matrix.update(state);
    }
}
