// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { UserVia } from "../../src/via.js";
import { UserViaPanel } from "../../src/web/uservia-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { decodedMeanings, decodedRow, teardownDom, ViaRegister } from "./helpers.js";

const { ORB, ORA, DDRB, DDRA, PCR } = ViaRegister;
const PcrCa2PulseOutput = 0x0a;

describe("UserViaPanel", () => {
    let scheduler;
    let via;
    let panel;
    let userPortInputs;

    beforeEach(() => {
        scheduler = new Scheduler();
        userPortInputs = 0xff;
        via = new UserVia({ interrupt: 0 }, scheduler, { read: () => userPortInputs, write: () => {} });
        panel = new UserViaPanel({
            cpu: { uservia: via },
            arrangement: new PanelArrangement(() => window.localStorage),
        });
    });

    afterEach(teardownDom);

    const meanings = (name) => decodedMeanings("uservia-panel", name);
    const titles = (name) =>
        [...decodedRow("uservia-panel", name).querySelectorAll(".decoded-meaning span")].map((span) => span.title);

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
});
