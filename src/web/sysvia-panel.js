import { hexword } from "../hex.js";
import { BBC } from "../keymap.js";
import { HwScrollSubtract } from "../video.js";
import { DecodedRegisters, namedBits } from "./decoded-registers.js";
import { FloatingPanel, panelArrangement } from "./floating-panel.js";
import { Centred, StartEdge } from "./panel-layout.js";

// The keypad's columns, 10 to 12, are scanned on a B as well, and the host's keypad reaches them.
const MatrixColumns = 13;
const MatrixRows = 8;
const MinPanelSize = { w: 240, h: 120 };
const StatusForms = ["Autoscan: column 15, no keys", "Port A: column 15, row 7"];
const IerReadsSet = 0x80;
const ScreenEnd = 0x8000;
const HwScrollUnit = 0x800;

const ControlLineModes = [
    "falling edge",
    "falling edge, independent",
    "rising edge",
    "rising edge, independent",
    "handshake output",
    "pulse output",
    "low output",
    "high output",
];
const Timer1Modes = ["one-shot", "continuous", "one-shot, PB7 pulse", "continuous, PB7 square wave"];
const ShiftRegisterModes = [
    "off",
    "in by T2",
    "in by clock",
    "in by CB1",
    "out free-running by T2",
    "out by T2",
    "out by clock",
    "out by CB1",
];

const Ca1 = { name: "CA1", wiring: "vsync", title: "the 6845's vertical sync" };
const Ca2 = {
    name: "CA2",
    wiring: "keyboard",
    title: "the keyboard: a key held as the autoscan passes it, or the key port A selects",
};
const Cb1 = { name: "CB1", wiring: "ADC", title: "the analogue to digital converter's end of conversion" };
const Cb2 = { name: "CB2", wiring: "light pen", title: "the 6845's light pen strobe" };

const InterruptSources = [
    { name: `CA2 ${Ca2.wiring}`, title: `CA2: ${Ca2.title}` },
    { name: `CA1 ${Ca1.wiring}`, title: `CA1: ${Ca1.title}` },
    { name: "SR", title: "The shift register has shifted eight bits" },
    { name: `CB2 ${Cb2.wiring}`, title: `CB2: ${Cb2.title}` },
    { name: `CB1 ${Cb1.wiring}`, title: `CB1: ${Cb1.title}` },
    { name: "T2", title: "Timer 2 has reached zero" },
    { name: "T1", title: "Timer 1 has reached zero; the OS runs it at 100 Hz" },
];

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

const lit = (text, title, on) => ({ text, title, lit: !!on });
const widest = (texts) => Math.max(...texts.map((text) => text.length));
/** A value spelt out, in a slot as wide as the widest of the `forms` it can take, so the panel keeps its size. */
const spelt = (text, title, forms) => ({ text, title, width: widest(forms) });
const fixed = (text, title) => spelt(text, title, [text]);

const KeyboardModes = ["keys: autoscan", "keys: port A"];
const ScreenSizes = HwScrollSubtract.map((subtract) => `screen ${(subtract * HwScrollUnit) / 1024}K`);
const KeySelections = ["column 15, row 7"];
const Timer2Modes = ["T2 counts PB6 pulses", "T2 one-shot"];
const Timer1Forms = Timer1Modes.map((mode) => `T1 ${mode}`);
const ShiftRegisterForms = ShiftRegisterModes.map((mode) => `SR ${mode}`);
const CountForms = ["65535 cycles", "65535 pulses"];

function keyboardSelection(portA) {
    return { column: portA & 0xf, row: (portA >>> 4) & 7 };
}

function decodeIc32(ic32, { isMaster }) {
    const scroll = (ic32 >>> 4) & 3;
    const wrapTo = ScreenEnd - HwScrollSubtract[scroll] * HwScrollUnit;
    return [
        lit("sound write", "B0, active low: the sound chip takes the slow data bus", !(ic32 & 1)),
        isMaster
            ? lit("RTC read", "B1: the real-time clock's read/write line, high to read", ic32 & 2)
            : lit("speech read", "B1, active low: the speech processor's read select", !(ic32 & 2)),
        isMaster
            ? lit("RTC data", "B2: the real-time clock's data strobe", ic32 & 4)
            : lit("speech write", "B2, active low: the speech processor's write select", !(ic32 & 4)),
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
        isMaster
            ? lit("RTC enable", "PB6: the real-time clock's chip enable", pins & 0x40)
            : lit("speech ready", "PB6, active low: the speech processor is ready", !(pins & 0x40)),
        isMaster
            ? lit("RTC address", "PB7: the real-time clock's address strobe", pins & 0x80)
            : lit("speech IRQ", "PB7, active low: the speech processor's interrupt", !(pins & 0x80)),
    ];
}

function edgeLine(line, risingBit) {
    const edge = risingBit ? "rising edge" : "falling edge";
    return spelt(
        `${line.name} ${line.wiring}: ${edge}`,
        `${line.name}, ${line.title}: interrupts on a ${edge}`,
        ControlLineModes.map((mode) => `${line.name} ${line.wiring}: ${mode}`),
    );
}

function controlLine(line, mode) {
    const what = ControlLineModes[mode];
    return spelt(
        `${line.name} ${line.wiring}: ${what}`,
        `${line.name}, ${line.title}: ${what}`,
        ControlLineModes.map((mode) => `${line.name} ${line.wiring}: ${mode}`),
    );
}

function decodePcr(pcr) {
    return [
        edgeLine(Ca1, pcr & 1),
        controlLine(Ca2, (pcr >>> 1) & 7),
        edgeLine(Cb1, pcr & 0x10),
        controlLine(Cb2, (pcr >>> 5) & 7),
    ];
}

function decodeAcr(acr) {
    return [
        spelt(Timer1Forms[acr >>> 6], "Bits 6 and 7: timer 1's mode", Timer1Forms),
        spelt(Timer2Modes[acr & 0x20 ? 0 : 1], "Bit 5: timer 2's mode", Timer2Modes),
        spelt(ShiftRegisterForms[(acr >>> 2) & 7], "Bits 2 to 4: the shift register's mode", ShiftRegisterForms),
        lit("PB latch", "Bit 1: port B latches its input on CB1's active edge", acr & 2),
        lit("PA latch", "Bit 0: port A latches its input on CA1's active edge", acr & 1),
    ];
}

function inCycles(value) {
    return [spelt(`${value} cycles`, "In cycles: the VIA counts at 1 MHz", CountForms)];
}

function decodeT2Counter(value, { acr }) {
    if (acr & 0x20) return [spelt(`${value} pulses`, "Falling edges on PB6 still to count", CountForms)];
    return inCycles(value);
}

const register = (name, title, bits, value, decode) => ({ name, title, bits, value, decode });
const noMeaning = () => [];

const Ic32Section = {
    heading: "IC32 latch",
    registers: [register("IC32", "The addressable latch port B writes", 8, (s) => s.ic32, decodeIc32)],
};

const PortsSection = {
    heading: "Ports",
    registers: [
        register("ORA", "Output register A", 8, (s) => s.ora, noMeaning),
        register("DDRA", "Port A's data direction: a set bit drives its line", 8, (s) => s.ddra, noMeaning),
        register("PA", "Port A's lines: the slow data bus", 8, (s) => s.portA, decodePortA),
        register("ORB", "Output register B", 8, (s) => s.orb, noMeaning),
        register("DDRB", "Port B's data direction: a set bit drives its line", 8, (s) => s.ddrb, noMeaning),
        register("PB", "Port B's lines", 8, (s) => s.portB, decodePortB),
    ],
};

const ControlSection = {
    heading: "Control",
    registers: [
        register("PCR", "Peripheral control: CA1, CA2, CB1 and CB2", 8, (s) => s.pcr, decodePcr),
        register("ACR", "Auxiliary control: the timers, shift register and latches", 8, (s) => s.acr, decodeAcr),
        register(
            "IFR",
            "Interrupt flags",
            8,
            (s) => s.ifr,
            namedBits([...InterruptSources, { name: "IRQ", title: "Some enabled flag is set" }]),
        ),
        register("IER", "Interrupts enabled", 8, (s) => s.ier, namedBits(InterruptSources)),
    ],
};

const TimersSection = {
    heading: "Timers",
    registers: [
        register("T1C", "Timer 1's counter, as a program reads it", 16, (s) => s.t1c, inCycles),
        register("T1L", "Timer 1's latch", 16, (s) => s.t1l, inCycles),
        register("T2C", "Timer 2's counter, as a program reads it", 16, (s) => s.t2c, decodeT2Counter),
        register("T2L", "Timer 2's latch, as last written", 16, (s) => s.t2l, inCycles),
    ],
};

/**
 * The system VIA and its keyboard as the panel shows them. Reading changes nothing the machine sees: the timers are
 * caught up as {@link Via#peekTimers} does, which is also what brings the interrupt flags up to date.
 * @param {import("../via.js").SysVia} via
 */
export function sysViaState(via) {
    const { t1c, t1l, t2c, t2l } = via.peekTimers();
    return {
        ic32: via.IC32,
        ora: via.ora,
        ddra: via.ddra,
        portA: via.portapins,
        orb: via.orb,
        ddrb: via.ddrb,
        portB: via.portbpins,
        pcr: via.pcr,
        acr: via.acr,
        ifr: via.ifr,
        ier: via.ier | IerReadsSet,
        t1c,
        t1l,
        t2c,
        t2l,
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
        if (this._status.textContent !== status) this._status.textContent = status;
    }
}

/**
 * A floating panel showing the system VIA decoded, with the keyboard matrix beside it, read once a frame while it is
 * open and not at all while it is closed.
 */
export class SysViaPanel {
    /**
     * @param {object} options
     * @param {() => import("../via.js").SysVia | undefined} options.via - the machine's, if it has one
     */
    constructor({ via }) {
        this._via = via;
        this._frameHandle = null;
        this.panel = document.getElementById("sysvia-panel");
        // The keyboard matrix heads the second column, which is why the sections are split as they are.
        this._registers = [
            new DecodedRegisters(this.panel.querySelector(".sysvia-ports"), [PortsSection, ControlSection]),
            new DecodedRegisters(this.panel.querySelector(".sysvia-latch"), [Ic32Section, TimersSection]),
        ];
        this._matrix = new KeyMatrix(
            this.panel.querySelector(".key-matrix"),
            this.panel.querySelector(".key-matrix-status"),
        );
        this.floating = new FloatingPanel({
            panel: this.panel,
            header: this.panel.querySelector(".register-panel-header"),
            closeButton: this.panel.querySelector(".register-panel-close"),
            id: "sysvia",
            place: { x: Centred, y: StartEdge },
            minSize: MinPanelSize,
            reopens: true,
            arrangement: panelArrangement,
        });
        this.floating.addEventListener("open", () => this._tick());
        this.floating.addEventListener("close", () => {
            cancelAnimationFrame(this._frameHandle);
            this._frameHandle = null;
        });
        for (const opener of document.querySelectorAll(".sysvia-open")) {
            opener.addEventListener("click", (e) => {
                e.preventDefault();
                this.floating.toggle();
            });
            // A focused button would keep keys from the machine and the debugger.
            opener.addEventListener("mousedown", (e) => e.preventDefault());
        }
        this.panel.addEventListener("mousedown", (e) => {
            if (e.target.closest("button")) e.preventDefault();
        });
    }

    update() {
        const via = this._via();
        if (!via) return;
        const state = sysViaState(via);
        for (const registers of this._registers) registers.update(state);
        this._matrix.update(state);
    }

    _tick() {
        this.update();
        this._frameHandle = requestAnimationFrame(() => this._tick());
    }
}
