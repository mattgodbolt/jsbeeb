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
const OneSectorOf256 = 0x21;

const WdControlAddr = 0;
const WdCommandAddr = 4;
const WdTrackAddr = 5;
const WdResetOff = 0x20;
const WdDrive1 = 0x02;
const WdSideUpper = 0x04;
const WdSeekVerify12ms = 0x10 | 0x04 | 0x01;

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

    function panelFor(Fdc, ...extra) {
        const cpu = fake6502();
        const drives = [0, 1].map((id) => new DiscDrive(id, scheduler, cpu.peripheralCyclesPerSecond));
        const fdc = new Fdc(cpu, scheduler, drives, {}, ...extra);
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
        const { fdc, panel } = panelFor(IntelFdc);
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
        expect(meanings("HEAD")).toEqual(["drive 0 side 0 track 0", "+selected", "-spinning"]);
    });

    it("shows the 1770's registers, with the status bits named for the kind of command", () => {
        const { fdc, panel } = panelFor(WdFdc, WdFdcVariant.wd1770);
        fdc.write(WdControlAddr, WdResetOff | WdDrive1 | WdSideUpper);
        fdc.write(WdTrackAddr, 7);
        fdc.write(WdCommandAddr, WdSeekVerify12ms);
        panel.update();
        expect(meanings("CMD")).toEqual(["seek", "+verify", "12 ms"]);
        expect(meanings("TR")).toEqual(["track 7"]);
        expect(meanings("CTL")).toEqual(["-reset", "MFM", "+side 1", "+sel 1", "-sel 0"]);
        expect(meanings("STA")).toContain("-track 0");
        expect(meanings("HEAD")).toEqual(["drive 1 side 1 track 0", "+selected", "+spinning"]);
    });

    it("logs the controller's commands in the panel while asked, and its state changes too when ticked", () => {
        const { fdc } = panelFor(IntelFdc);
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

    it("shows the head on the disc of the drive last selected", () => {
        const { fdc, panel } = panelFor(WdFdc, WdFdcVariant.wd1770);
        fdc.write(WdControlAddr, WdResetOff | WdDrive1);
        panel.update();
        fdc.write(WdControlAddr, WdResetOff);
        panel.update();
        expect(meanings("HEAD")).toContain("-selected");
        expect(meanings("HEAD")[0]).toMatch(/^drive 1 /);
        part("fdc-zoom").click();
        expect(visualiser.zoomToHead).toHaveBeenCalledWith(1);
    });
});
