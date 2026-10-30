import { hexbyte } from "../hex.js";
import { decodedPanel, DecodedRegisters, fixed, lit } from "./decoded-registers.js";
import { Centred, StartEdge } from "./panel-layout.js";
import { controlSection, portsSection, TimersSection, viaState } from "./via-registers.js";

const MinPanelSize = { w: 240, h: 120 };
const PortLines = 8;
const FirstPrintable = 0x20;
const LastPrintable = 0x7e;

/** @type {import("./via-registers.js").ViaWiring} */
const Wiring = {
    ca1: {
        name: "CA1",
        wiring: "printer ack",
        title: "the printer's acknowledge, pulsed low as it takes each character",
    },
    ca2: { name: "CA2", wiring: "printer strobe", title: "the printer's strobe, pulsed low to hand it a character" },
    cb1: { name: "CB1", wiring: "user port", title: "a control line on the user port" },
    cb2: { name: "CB2", wiring: "user port", title: "a control line on the user port" },
    t1: "Timer 1 has reached zero",
};

function decodePrinterData(pins) {
    const printable = pins >= FirstPrintable && pins <= LastPrintable;
    const char = printable ? `"${String.fromCharCode(pins)}"` : `&${hexbyte(pins)}`;
    return [fixed(`data ${char}`, "PA0-PA7: the character on the printer's data lines")];
}

/** Each of the user port's lines, most significant first, lit while high. */
function decodeUserPort(pins, { ddrb }) {
    const lines = [];
    for (let bit = PortLines - 1; bit >= 0; --bit) {
        const mask = 1 << bit;
        const direction = ddrb & mask ? "an output, driven" : "an input, read";
        const level = pins & mask ? "high" : "low";
        lines.push(lit(`PB${bit}`, `PB${bit} on the user port: ${direction} ${level}`, pins & mask));
    }
    return lines;
}

const Sections = {
    ports: portsSection({
        a: { title: "Port A's lines: the printer's data", decode: decodePrinterData },
        b: { title: "Port B's lines: the user port", decode: decodeUserPort },
    }),
    control: controlSection(Wiring),
};

/** A floating panel showing the user VIA decoded: the printer on port A, the user port on port B. */
export class UserViaPanel {
    /** Whether the machine has a user VIA to show: the Atom's CPU carries one it never wires up. */
    static fits(cpu) {
        return !cpu.model.isAtom;
    }

    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     */
    constructor({ cpu, arrangement }) {
        this._via = cpu.uservia;
        const { floating, body, part } = decodedPanel({
            id: "uservia",
            title: "User VIA",
            feature: "user_via",
            place: () => ({ x: Centred, y: StartEdge }),
            minSize: MinPanelSize,
            arrangement,
            draw: () => this.update(),
        });
        this.floating = floating;
        body.innerHTML = `<div class="uservia-ports"></div><div class="uservia-control"></div>`;
        this._registers = [
            new DecodedRegisters(part("uservia-ports"), [Sections.ports, TimersSection]),
            new DecodedRegisters(part("uservia-control"), [Sections.control]),
        ];
        this.update();
    }

    update() {
        const state = viaState(this._via);
        for (const registers of this._registers) registers.update(state);
    }
}
