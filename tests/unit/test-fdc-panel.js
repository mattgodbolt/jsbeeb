// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscDrive } from "../../src/disc-drive.js";
import { fake6502 } from "../../src/fake6502.js";
import { IntelFdc } from "../../src/intel-fdc.js";
import { Scheduler } from "../../src/scheduler.js";
import { WdFdc, WdFdcVariant } from "../../src/wd-fdc.js";
import { FdcPanel } from "../../src/web/fdc-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { decodedMeanings, teardownDom } from "./helpers.js";

const IntelCommandAddr = 0;
const IntelParamAddr = 1;
const IntelSelect0 = 0x40;
const IntelReadData = (0x04 << 2) | IntelSelect0 | 3;
const IntelSeek = (0x0a << 2) | IntelSelect0 | 1;
const IntelUnwiredAddr = 3;
const IntelWriteSpecialRegister = 0x3a;
const IntelDriveOutRegister = 0x23;
const IntelLoadHeadOnDrive1 = 0x80 | 0x08;
const MaxLogLines = 500;
const OneSectorOf256 = 0x21;

const WdControlAddr = 0;
const WdCommandAddr = 4;
const WdTrackAddr = 5;
const WdResetOff = 0x20;
const WdDrive1 = 0x02;
const WdSideUpper = 0x04;
const WdSeekVerify12ms = 0x10 | 0x04 | 0x01;
const WdReadSector = 0x80;
const WdForceInterrupt = 0xd0;
const PastAbortCycles = 1000;

describe("FdcPanel", () => {
    let scheduler;
    let visualiser;

    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        scheduler = new Scheduler();
        visualiser = { zoomToHead: vi.fn() };
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await teardownDom();
    });

    function panelFor(Fdc, debugFlags) {
        const cpu = fake6502();
        const drives = [0, 1].map((id) => new DiscDrive(id, scheduler, cpu.peripheralCyclesPerSecond));
        const fdc =
            Fdc === WdFdc
                ? new WdFdc(cpu, scheduler, drives, debugFlags, WdFdcVariant.wd1770)
                : new IntelFdc(cpu, scheduler, drives, debugFlags);
        const panel = new FdcPanel({
            cpu: { fdc },
            arrangement: new PanelArrangement(() => window.localStorage),
            visualiser,
        });
        return { fdc, panel };
    }

    const meanings = (name) => decodedMeanings("fdc-panel", name);
    const part = (className) => document.querySelector(`#fdc-panel .${className}`);
    const logLines = () => [...part("fdc-log").children].map((line) => line.textContent);

    it("shows the 8271's command by name, its parameters by what they mean, and that it waits for the rest", () => {
        const { fdc, panel } = panelFor(IntelFdc, {});
        fdc.write(IntelCommandAddr, IntelReadData);
        fdc.write(IntelParamAddr, 5);
        fdc.write(IntelParamAddr, 2);
        panel.update();
        expect(meanings("CMD")).toEqual(["read data"]);
        expect(meanings("P1")).toEqual(["track 5"]);
        expect(meanings("P2")).toEqual(["sector 2"]);
        expect(meanings("PHASE")).toEqual(["waiting for parameters"]);
        expect(meanings("STA")).toContain("+busy");
        fdc.write(IntelParamAddr, OneSectorOf256);
        panel.update();
        expect(meanings("P3")).toEqual(["1 × 256 bytes"]);
        expect(meanings("OUT")).toContain("+sel 0");
        expect(meanings("HEAD")).toEqual(["drive 0 side 0 track 0", "-selected", "-spinning"]);
    });

    it("shows the 1770's registers, with the status bits named for the kind of command in force", () => {
        const { fdc, panel } = panelFor(WdFdc, {});
        fdc.write(WdControlAddr, WdResetOff | WdDrive1 | WdSideUpper);
        fdc.write(WdTrackAddr, 7);
        fdc.write(WdCommandAddr, WdSeekVerify12ms);
        panel.update();
        expect(meanings("CMD")).toEqual(["seek", "+verify", "12 ms"]);
        expect(meanings("TR")).toEqual(["track 7"]);
        expect(meanings("CTL")).toEqual(["-reset", "MFM", "+side 1", "+sel 1", "-sel 0"]);
        expect(meanings("STA")).toContain("-track 0");
        expect(meanings("HEAD")).toEqual(["drive 1 side 1 track 0", "+selected", "+spinning"]);
        expect(document.querySelector("#fdc-panel .decoded-heading").textContent).toBe("WD1770 command");
        fdc.write(WdCommandAddr, WdForceInterrupt);
        scheduler.polltime(PastAbortCycles);
        fdc.write(WdCommandAddr, WdReadSector);
        panel.update();
        expect(meanings("STA")).toEqual(expect.arrayContaining(["+busy", "-lost", "-DRQ"]));
        fdc.write(WdCommandAddr, WdForceInterrupt);
        scheduler.polltime(PastAbortCycles);
        fdc.write(WdCommandAddr, WdForceInterrupt);
        panel.update();
        expect(meanings("CMD")).toEqual(["read sector", "-multi", "-settle"]);
        expect(meanings("STA")).toContain("-track 0");
    });

    it("logs the controller's commands in the panel while asked, and its state changes too when ticked", () => {
        const { fdc } = panelFor(IntelFdc, {});
        const commands = part("fdc-log-commands");
        const states = part("fdc-log-states");
        expect(commands.textContent).toBe("start");
        commands.click();
        expect(commands.textContent).toBe("stop");
        fdc.write(IntelCommandAddr, IntelSeek);
        fdc.write(IntelParamAddr, 3);
        expect(logLines()[0]).toMatch(/^8271: command 29 sel 40 params 03/);
        expect(states.getAttribute("aria-checked")).toBe("false");
        states.click();
        expect(states.getAttribute("aria-checked")).toBe("true");
        expect(fdc.logStateChanges).toBe(true);
        part("fdc-log-clear").click();
        expect(logLines()).toEqual([]);
        commands.click();
        states.click();
        fdc.write(IntelCommandAddr, IntelSeek);
        fdc.write(IntelParamAddr, 4);
        expect(logLines().filter((line) => /command 29 sel/.test(line))).toEqual([]);
    });

    it("logs state changes by name", () => {
        const { fdc } = panelFor(WdFdc, {});
        part("fdc-log-states").click();
        fdc.write(WdControlAddr, WdResetOff | WdDrive1);
        fdc.write(WdCommandAddr, WdReadSector);
        expect(logLines()).toContainEqual(expect.stringMatching(/^WD1770: State idle -> spinUpWait /));
    });

    it("keeps the last lines of the log, among them the warnings the controller logs unasked", () => {
        const { fdc } = panelFor(IntelFdc, {});
        for (let value = 0; value <= MaxLogLines; ++value) fdc.write(IntelUnwiredAddr, value & 0xff);
        expect(logLines()).toHaveLength(MaxLogLines);
        expect(logLines()[0]).toBe("8271: Not supported: 0003=01");
    });

    it("shows the log as on when the page's flags turned it on", () => {
        panelFor(IntelFdc, { logFdcCommands: true, logFdcStateChanges: true });
        expect(part("fdc-log-commands").textContent).toBe("stop");
        expect(part("fdc-log-states").getAttribute("aria-checked")).toBe("true");
    });

    it("counts an 8271's drive as selected only while load head lets its select through", () => {
        const { fdc, panel } = panelFor(IntelFdc, {});
        fdc.write(IntelCommandAddr, IntelWriteSpecialRegister);
        fdc.write(IntelParamAddr, IntelDriveOutRegister);
        fdc.write(IntelParamAddr, IntelLoadHeadOnDrive1);
        panel.update();
        expect(meanings("HEAD")).toEqual(["drive 1 side 0 track 0", "+selected", "+spinning"]);
    });

    it.each([
        {
            Fdc: IntelFdc,
            select: (fdc) => {
                fdc.write(IntelCommandAddr, IntelWriteSpecialRegister);
                fdc.write(IntelParamAddr, IntelDriveOutRegister);
                fdc.write(IntelParamAddr, IntelLoadHeadOnDrive1);
            },
        },
        { Fdc: WdFdc, select: (fdc) => fdc.write(WdControlAddr, WdResetOff | WdDrive1) },
    ])("shows the drive selected in a state the $Fdc.name restores", async ({ Fdc, select }) => {
        const { fdc: saved } = panelFor(Fdc, {});
        select(saved);
        const state = saved.snapshotState();
        await teardownDom();
        const { fdc, panel } = panelFor(Fdc, {});
        fdc.restoreState(state);
        panel.update();
        expect(meanings("HEAD")[0]).toMatch(/^drive 1 /);
    });

    it("shows the head on the disc of the drive last selected, even if it came and went while the panel was not drawn", () => {
        const { fdc, panel } = panelFor(WdFdc, {});
        fdc.write(WdControlAddr, WdResetOff | WdDrive1);
        fdc.write(WdControlAddr, WdResetOff);
        panel.update();
        expect(meanings("HEAD")).toContain("-selected");
        expect(meanings("HEAD")[0]).toMatch(/^drive 1 /);
        part("fdc-zoom").click();
        expect(visualiser.zoomToHead).toHaveBeenCalledWith(1);
    });
});
