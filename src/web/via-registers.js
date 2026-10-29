import { lit, namedBits, noMeaning, register, spelt } from "./decoded-registers.js";

const IerReadsSet = 0x80;

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
const Timer1Forms = Timer1Modes.map((mode) => `T1 ${mode}`);
const Timer2Modes = ["T2 counts PB6 pulses", "T2 one-shot"];
const ShiftRegisterForms = ShiftRegisterModes.map((mode) => `SR ${mode}`);
const CountForms = ["65535 cycles", "65535 pulses"];

/**
 * @typedef {object} ControlLine what a VIA's control line is wired to on this machine
 * @property {string} name CA1, CA2, CB1 or CB2
 * @property {string} wiring a word or two, shown beside the name
 * @property {string} title what it is wired to, in full
 */

/**
 * @typedef {object} ViaWiring
 * @property {ControlLine} ca1
 * @property {ControlLine} ca2
 * @property {ControlLine} cb1
 * @property {ControlLine} cb2
 * @property {string} t1 what timer 1 reaching zero means here
 */

/**
 * @typedef {object} PortLines what a port's lines are wired to
 * @property {string} title
 * @property {(pins: number, state: object) => import("./decoded-registers.js").Meaning[]} decode
 */

/**
 * The registers every VIA has, as the decoded panels show them. Reading changes nothing the machine sees: the timers
 * are caught up as {@link Via#peekTimers} does, which is also what brings the interrupt flags up to date.
 * @param {import("../via.js").Via} via
 */
export function viaState(via) {
    const { t1c, t1l, t2c, t2l } = via.peekTimers();
    return {
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
    };
}

function controlLineForms(line) {
    return ControlLineModes.map((mode) => `${line.name} ${line.wiring}: ${mode}`);
}

function edgeLine(line, risingBit) {
    const edge = risingBit ? "rising edge" : "falling edge";
    return spelt(
        `${line.name} ${line.wiring}: ${edge}`,
        `${line.name}, ${line.title}: interrupts on a ${edge}`,
        controlLineForms(line),
    );
}

function controlLine(line, mode) {
    const what = ControlLineModes[mode];
    return spelt(
        `${line.name} ${line.wiring}: ${what}`,
        `${line.name}, ${line.title}: ${what}`,
        controlLineForms(line),
    );
}

function decodePcr(pcr, { ca1, ca2, cb1, cb2 }) {
    return [
        edgeLine(ca1, pcr & 1),
        controlLine(ca2, (pcr >>> 1) & 7),
        edgeLine(cb1, pcr & 0x10),
        controlLine(cb2, (pcr >>> 5) & 7),
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

/** By bit number in the IFR and IER. */
function interruptSources({ ca1, ca2, cb1, cb2, t1 }) {
    const line = ({ name, wiring, title }) => ({ name: `${name} ${wiring}`, title: `${name}: ${title}` });
    return [
        line(ca2),
        line(ca1),
        { name: "SR", title: "The shift register has shifted eight bits" },
        line(cb2),
        line(cb1),
        { name: "T2", title: "Timer 2 has reached zero" },
        { name: "T1", title: t1 },
    ];
}

/**
 * The output registers, data directions and lines of both ports.
 * @param {{a: PortLines, b: PortLines}} ports
 */
export function portsSection({ a, b }) {
    return {
        heading: "Ports",
        registers: [
            register("ORA", "Output register A", 8, (s) => s.ora, noMeaning),
            register("DDRA", "Port A's data direction: a set bit drives its line", 8, (s) => s.ddra, noMeaning),
            register("PA", a.title, 8, (s) => s.portA, a.decode),
            register("ORB", "Output register B", 8, (s) => s.orb, noMeaning),
            register("DDRB", "Port B's data direction: a set bit drives its line", 8, (s) => s.ddrb, noMeaning),
            register("PB", b.title, 8, (s) => s.portB, b.decode),
        ],
    };
}

/**
 * The PCR and ACR, and the interrupts flagged and enabled, named by what this machine wires to them.
 * @param {ViaWiring} wiring
 */
export function controlSection(wiring) {
    const sources = interruptSources(wiring);
    return {
        heading: "Control",
        registers: [
            register(
                "PCR",
                "Peripheral control: CA1, CA2, CB1 and CB2",
                8,
                (s) => s.pcr,
                (pcr) => decodePcr(pcr, wiring),
            ),
            register("ACR", "Auxiliary control: the timers, shift register and latches", 8, (s) => s.acr, decodeAcr),
            register(
                "IFR",
                "Interrupt flags",
                8,
                (s) => s.ifr,
                namedBits([...sources, { name: "IRQ", title: "Some enabled flag is set" }]),
            ),
            register("IER", "Interrupts enabled", 8, (s) => s.ier, namedBits(sources)),
        ],
    };
}

export const TimersSection = {
    heading: "Timers",
    registers: [
        register("T1C", "Timer 1's counter, as a program reads it", 16, (s) => s.t1c, inCycles),
        register("T1L", "Timer 1's latch", 16, (s) => s.t1l, inCycles),
        register("T2C", "Timer 2's counter, as a program reads it", 16, (s) => s.t2c, decodeT2Counter),
        register("T2L", "Timer 2's latch, as last written", 16, (s) => s.t2l, inCycles),
    ],
};
