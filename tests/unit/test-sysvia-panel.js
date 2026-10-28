// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BBC } from "../../src/keymap.js";
import { Scheduler } from "../../src/scheduler.js";
import { SysVia } from "../../src/via.js";
import { SysViaPanel } from "../../src/web/sysvia-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const ORB = 0x0,
    ORA = 0x1,
    DDRB = 0x2,
    DDRA = 0x3,
    T1CL = 0x4,
    T1CH = 0x5,
    T2CL = 0x8,
    T2CH = 0x9,
    ACR = 0xb,
    PCR = 0xc,
    IER = 0xe;
const PortBLatchLines = 0x0f;
const PortBRtcLines = 0xc0;
const LatchSet = 0x08;
const LatchAutoscan = 3;
const LatchCapsLock = 6;
const LatchScreenC0 = 4;
const LatchScreenC1 = 5;
const IerSetT1AndCa2 = 0xc1;
const PcrCa1RisingCa2RisingIndependentCb2PulseOut = 0xa7;
const AcrT1ContinuousT2CountsPb6 = 0x60;
const TicksPerMicrosecond = 2;
const TicksPerScanColumn = 2;
const MatrixColumns = 13;

describe("SysViaPanel", () => {
    let scheduler;
    let cpu;
    let via;
    let panel;
    let frames;

    const makeVia = (isMaster) =>
        new SysVia(cpu, scheduler, {
            video: { setScreenHwScroll: () => {} },
            soundChip: { updateSlowDataBus: () => {} },
            cmos: { writeControl: () => {}, read: () => 0xff },
            isMaster,
            initialLayout: "physical",
        });

    beforeEach(() => {
        domFromIndexHtml("sysvia-panel", "peripherals-panel");
        frames = [];
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => frames.splice(0));
        scheduler = new Scheduler();
        cpu = { interrupt: 0 };
        via = makeVia(false);
        via.write(DDRB, PortBLatchLines);
        panel = new SysViaPanel({ via: () => via, arrangement: new PanelArrangement(() => window.localStorage) });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        teardownDom();
    });

    const isOpen = () => !document.getElementById("sysvia-panel").hidden;
    const nextFrame = () => frames.shift()();
    const setLatch = (bit, level) => via.write(ORB, bit | (level ? LatchSet : 0));
    const registerRow = (name) =>
        [...document.querySelectorAll(".decoded-registers tr")].find(
            (row) => row.querySelector("th")?.textContent === name,
        );
    const hex = (name) => registerRow(name).querySelector(".decoded-hex").textContent;
    /** A lit bit as +name, an unlit one as -name, and a value spelt out as itself. */
    const meanings = (name) =>
        [...registerRow(name).querySelectorAll(".decoded-meaning span")].map((span) => {
            if (span.classList.contains("decoded-value")) return span.textContent;
            return `${span.classList.contains("lit") ? "+" : "-"}${span.textContent}`;
        });
    const matrixCell = ([column, row]) =>
        document.querySelectorAll(".key-matrix tbody tr")[row].querySelectorAll("td")[column];
    const matrixColumns = () => document.querySelectorAll(".key-matrix thead th").length - 1;
    const scannedColumn = () => document.querySelector(".key-matrix thead th.scanned")?.textContent;
    const matrixStatus = () => document.querySelector(".key-matrix-status").textContent;

    describe("opening", () => {
        it.each([
            ["its own toggle, as the Debug menu does", () => ({ click: () => panel.floating.toggle() })],
            ["the peripherals panel's system VIA section", () => document.querySelector("#sysvia .sysvia-open")],
        ])("opens and closes from %s, and reads the VIA once a frame only while open", (_, opener) => {
            opener().click();
            expect(isOpen()).toBe(true);
            expect(hex("IC32")).toBe("00");
            setLatch(LatchCapsLock, true);
            expect(hex("IC32")).toBe("00");
            nextFrame();
            expect(hex("IC32")).toBe("40");
            opener().click();
            expect(isOpen()).toBe(false);
            expect(frames).toEqual([]);
        });

        it("keeps focus where it was, as the keyboard belongs to the machine", () => {
            for (const opener of document.querySelectorAll("#sysvia-panel button")) {
                const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                opener.dispatchEvent(press);
                expect(press.defaultPrevented).toBe(true);
            }
        });

        it("is laid out unseen before the debugger has a machine, and shows the machine once there is one", () => {
            const machine = via;
            via = undefined;
            const awaiting = () =>
                document.querySelector("#sysvia-panel .panel-body").classList.contains("awaiting-machine");
            panel.floating.open();
            expect(awaiting()).toBe(true);
            expect(meanings("IFR")).toHaveLength(8);
            via = machine;
            nextFrame();
            expect(awaiting()).toBe(false);
        });
    });

    describe("the registers", () => {
        beforeEach(() => panel.floating.open());

        it("names IC32's bits, the active-low ones lit when low", () => {
            expect(meanings("IC32")).toEqual([
                "+sound write",
                "+speech read",
                "+speech write",
                "keys: port A",
                "screen 16K",
                "+caps lock",
                "+shift lock",
            ]);
            setLatch(0, true);
            setLatch(LatchAutoscan, true);
            setLatch(LatchCapsLock, true);
            setLatch(LatchScreenC1, true);
            panel.update();
            expect(meanings("IC32")).toEqual([
                "-sound write",
                "+speech read",
                "+speech write",
                "keys: autoscan",
                "screen 20K",
                "-caps lock",
                "+shift lock",
            ]);
            setLatch(LatchScreenC0, true);
            panel.update();
            expect(meanings("IC32")).toContain("screen 10K");
        });

        it("names the Master's real-time clock lines where a B has speech, each in a slot that fits either", () => {
            const chipWidths = () =>
                ["IC32", "PB"].map((name) =>
                    [...registerRow(name).querySelectorAll(".decoded-bit")].map((chip) => chip.style.width),
                );
            const onB = chipWidths();
            via = makeVia(true);
            via.write(DDRB, PortBLatchLines | PortBRtcLines);
            via.write(ORB, 0x40 | 1 | LatchSet);
            panel.update();
            expect(meanings("IC32").slice(1, 3)).toEqual(["+RTC read", "-RTC data"]);
            expect(meanings("PB")).toEqual(["latch B1 = 1", "-fire 1", "-fire 2", "+RTC enable", "-RTC address"]);
            expect(chipWidths()).toEqual(onB);
        });

        it("spells out port B's lines and the PCR's roles with their wiring", () => {
            setLatch(LatchAutoscan, true);
            via.write(PCR, PcrCa1RisingCa2RisingIndependentCb2PulseOut);
            via.setJoystickButton(0, true);
            panel.update();
            expect(meanings("PB")).toEqual(["latch B3 = 1", "+fire 1", "-fire 2", "-speech ready", "-speech IRQ"]);
            expect(meanings("PCR")).toEqual([
                "CA1 vsync: rising edge",
                "CA2 keyboard: rising edge, independent",
                "CB1 ADC: falling edge",
                "CB2 light pen: pulse output",
            ]);
        });

        it("names the ACR's modes and the interrupts flagged and enabled", () => {
            via.write(ACR, AcrT1ContinuousT2CountsPb6);
            via.write(IER, IerSetT1AndCa2);
            via.write(T1CL, 10);
            via.write(T1CH, 0);
            scheduler.polltime(20 * TicksPerMicrosecond);
            panel.update();
            expect(meanings("ACR")).toEqual([
                "T1 continuous",
                "T2 counts PB6 pulses",
                "SR off",
                "-PB latch",
                "-PA latch",
            ]);
            const sources = ["T1", "T2", "CB1 ADC", "CB2 light pen", "SR", "CA1 vsync", "CA2 keyboard"];
            expect(meanings("IFR")).toEqual(["+IRQ", "+T1", ...sources.slice(1).map((name) => `-${name}`)]);
            expect(hex("IER")).toBe("c1");
            expect(meanings("IER")).toEqual([
                "+T1",
                ...sources.slice(1, -1).map((name) => `-${name}`),
                "+CA2 keyboard",
            ]);
            expect(meanings("T2C")).toEqual(["65534 pulses"]);
        });

        it("gives the timers in cycles as a program would read them now, without clearing the flag", () => {
            via.write(T1CL, 0x10);
            via.write(T1CH, 0x27);
            via.write(T2CL, 0xe8);
            via.write(T2CH, 0x03);
            scheduler.polltime(100 * TicksPerMicrosecond);
            panel.update();
            expect(hex("T1L")).toBe("2710");
            expect(meanings("T1L")).toEqual(["10000 cycles"]);
            expect(meanings("T1C")).toEqual(["9901 cycles"]);
            expect(meanings("T2C")).toEqual(["901 cycles"]);
            scheduler.polltime(1000 * TicksPerMicrosecond);
            panel.update();
            expect(meanings("IFR")).toContain("+T2");
            panel.update();
            expect(meanings("IFR")).toContain("+T2");
        });

        it("reads the selected key from port A while the keyboard is not scanning itself", () => {
            via.write(DDRA, 0x7f);
            via.write(ORA, (BBC.A[1] << 4) | BBC.A[0]);
            via.keyDownRaw(BBC.A);
            panel.update();
            expect(meanings("PA")).toEqual([`column ${BBC.A[0]}, row ${BBC.A[1]}`, "+key down"]);
            via.keyUpRaw(BBC.A);
            panel.update();
            expect(meanings("PA")).toEqual([`column ${BBC.A[0]}, row ${BBC.A[1]}`, "-key down"]);
            setLatch(LatchAutoscan, true);
            panel.update();
            expect(meanings("PA")).toEqual([]);
        });
    });

    describe("the keyboard matrix", () => {
        beforeEach(() => panel.floating.open());

        it("lays out the thirteen columns the keyboard is scanned on, keys named where they sit", () => {
            expect(matrixColumns()).toBe(MatrixColumns);
            expect(matrixCell(BBC.A).textContent).toBe("A");
            expect(matrixCell(BBC.K1).textContent).toBe("1");
            expect(matrixCell(BBC.SHIFT).title).toBe("shift: column 0, row 0");
            expect(matrixCell(BBC.NUMPAD7).textContent).toBe("k7");
            expect(matrixCell(BBC.NUMPAD7).title).toBe("keypad 7: column 11, row 1");
        });

        it("marks the keys held, and the column the autoscan counter is on", () => {
            setLatch(LatchAutoscan, true);
            via.keyDownRaw(BBC.SHIFT);
            via.keyDownRaw(BBC.Q);
            scheduler.polltime(7 * TicksPerScanColumn);
            panel.update();
            expect(matrixCell(BBC.SHIFT).classList.contains("held")).toBe(true);
            expect(matrixCell(BBC.Q).classList.contains("held")).toBe(true);
            expect(matrixCell(BBC.A).classList.contains("held")).toBe(false);
            expect(scannedColumn()).toBe("7");
            expect(matrixStatus()).toBe("Autoscan: column 7");
            scheduler.polltime(7 * TicksPerScanColumn);
            panel.update();
            expect(scannedColumn()).toBeUndefined();
            expect(matrixStatus()).toBe("Autoscan: column 14, no keys");
        });

        it("marks the key port A selects while the keyboard is not scanning itself", () => {
            via.write(DDRA, 0x7f);
            via.write(ORA, (BBC.RETURN[1] << 4) | BBC.RETURN[0]);
            panel.update();
            expect(scannedColumn()).toBe(String(BBC.RETURN[0]));
            expect(matrixCell(BBC.RETURN).classList.contains("selected")).toBe(true);
            expect(document.querySelectorAll(".key-matrix td.selected")).toHaveLength(1);
            expect(matrixStatus()).toBe(`Port A: column ${BBC.RETURN[0]}, row ${BBC.RETURN[1]}`);
        });
    });
});
