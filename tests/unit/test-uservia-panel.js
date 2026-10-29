// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { UserVia } from "../../src/via.js";
import { UserViaPanel } from "../../src/web/uservia-panel.js";
import { DebugGroup, PanelArrangement } from "../../src/web/floating-panel.js";
import { findModel } from "../../src/models.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const ORB = 0x0,
    ORA = 0x1,
    DDRB = 0x2,
    DDRA = 0x3,
    T1CL = 0x4,
    T1CH = 0x5,
    PCR = 0xc;
const PcrCa2PulseOutput = 0x0a;
const TicksPerMicrosecond = 2;

describe("UserViaPanel", () => {
    let scheduler;
    let via;
    let arrangement;
    let panel;
    let userPortInputs;

    beforeEach(() => {
        domFromIndexHtml("peripherals-panel");
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
        scheduler = new Scheduler();
        userPortInputs = 0xff;
        via = new UserVia({ interrupt: 0 }, scheduler, false, { read: () => userPortInputs, write: () => {} });
        arrangement = new PanelArrangement(() => window.localStorage);
        arrangement.followMachine(() => scheduler.epoch);
        panel = new UserViaPanel({ cpu: { uservia: via }, arrangement });
        panel.floating.open();
    });

    afterEach(teardownDom);

    const registerRow = (name) =>
        [...document.querySelectorAll("#uservia-panel .decoded-registers tr")].find(
            (row) => row.querySelector("th")?.textContent === name,
        );
    /** A lit bit as +name, an unlit one as -name, and a value spelt out as itself. */
    const meanings = (name) =>
        [...registerRow(name).querySelectorAll(".decoded-meaning span")].map((span) => {
            if (span.classList.contains("decoded-value")) return span.textContent;
            return `${span.classList.contains("lit") ? "+" : "-"}${span.textContent}`;
        });
    const titles = (name) => [...registerRow(name).querySelectorAll(".decoded-meaning span")].map((span) => span.title);

    it("is made for a BBC or a Master, not for an Atom, whose CPU carries a user VIA it never wires up", () => {
        const fits = (name) => UserViaPanel.fits({ model: findModel(name) });
        expect([fits("B-DFS1.2"), fits("Master"), fits("Atom")]).toEqual([true, true, false]);
    });

    it("opens and closes from the peripherals panel's user VIA section, as one of the debugger's panels", () => {
        const opener = document.querySelector('#uservia [data-opens="uservia-panel"]');
        opener.click();
        expect(panel.floating.isOpen).toBe(false);
        opener.click();
        expect(panel.floating.isOpen).toBe(true);
        expect(arrangement.group(DebugGroup)).toEqual([panel.floating]);
        expect(arrangement.listed().map(({ title }) => title)).toEqual(["User VIA"]);
    });

    it("shows the character on the printer's data lines, and a byte that is not one in hex", () => {
        via.write(DDRA, 0xff);
        via.write(ORA, 0x41);
        panel.update();
        expect(meanings("PA")).toEqual(['data "A"']);
        via.write(ORA, 0x0d);
        panel.update();
        expect(meanings("PA")).toEqual(["data &0d"]);
    });

    it("lights each user port line that is high, saying which the VIA drives and which it reads", () => {
        userPortInputs = 0xbf;
        via.write(DDRB, 0x0f);
        via.write(ORB, 0x05);
        panel.update();
        expect(meanings("PB")).toEqual(["+PB7", "-PB6", "+PB5", "+PB4", "-PB3", "+PB2", "-PB1", "+PB0"]);
        expect(titles("PB")[1]).toBe("PB6 on the user port: an input, read low");
        expect(titles("PB")[7]).toBe("PB0 on the user port: an output, driven high");
        via.write(DDRB, 0xff);
        via.write(ORB, 0xff);
        userPortInputs = 0xff;
        panel.update();
        via.write(DDRB, 0x00);
        panel.update();
        expect(meanings("PB")).toEqual(["+PB7", "+PB6", "+PB5", "+PB4", "+PB3", "+PB2", "+PB1", "+PB0"]);
        expect(titles("PB")[7]).toBe("PB0 on the user port: an input, read high");
    });

    it("names the PCR's lines and the interrupts by the printer and user port wired to them", () => {
        via.write(PCR, PcrCa2PulseOutput);
        via.setca1(true);
        via.setca1(false);
        panel.update();
        expect(meanings("PCR")).toEqual([
            "CA1 printer ack: falling edge",
            "CA2 printer strobe: pulse output",
            "CB1 user port: falling edge",
            "CB2 user port: falling edge",
        ]);
        expect(meanings("IFR")).toEqual([
            "-IRQ",
            "-T1",
            "-T2",
            "-CB1 user port",
            "-CB2 user port",
            "-SR",
            "+CA1 printer ack",
            "-CA2 printer strobe",
        ]);
    });

    it("gives the timers in cycles, and keeps up once a frame as the machine moves on", () => {
        via.write(T1CL, 0x10);
        via.write(T1CH, 0x27);
        scheduler.polltime(100 * TicksPerMicrosecond);
        const [frame] = window.requestAnimationFrame.mock.calls.at(-1);
        frame();
        expect(meanings("T1L")).toEqual(["10000 cycles"]);
        expect(meanings("T1C")).toEqual(["9901 cycles"]);
    });
});
