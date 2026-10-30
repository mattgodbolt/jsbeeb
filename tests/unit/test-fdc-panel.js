// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscDrive } from "../../src/disc-drive.js";
import { fake6502 } from "../../src/fake6502.js";
import { IntelFdc } from "../../src/intel-fdc.js";
import { Scheduler } from "../../src/scheduler.js";
import { findModel } from "../../src/models.js";
import { WdFdc, WdFdcVariant } from "../../src/wd-fdc.js";
import { FdcPanel } from "../../src/web/fdc-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { blankDisc } from "../helpers/disc-builders.js";
import { decodedMeanings, teardownDom } from "./helpers.js";

const IntelCommandAddr = 0;
const IntelParamAddr = 1;
const IntelSelect0 = 0x40;
const IntelReadData = (0x04 << 2) | IntelSelect0 | 3;
const IntelSeek = (0x0a << 2) | IntelSelect0 | 1;
const IntelReadDriveStatus = (0x0b << 2) | IntelSelect0;
const IntelUnwiredAddr = 3;
const IntelWriteSpecialRegister = 0x3a;
const IntelReadSpecialRegister = (0x0f << 2) | IntelSelect0 | 1;
const IntelDriveOutRegister = 0x23;
const IntelLoadHeadOnDrive0 = IntelSelect0 | 0x08;
const IntelSpecify = 0x35;
const IntelSpecifyLikeDfs = [0x0d, 12, 10, 0xc8];
const IntelLoadHeadOnDrive1 = 0x80 | 0x08;
const OneSectorOf256 = 0x21;

const WdControlAddr = 0;
const WdCommandAddr = 4;
const WdTrackAddr = 5;
const WdSectorAddr = 6;
const WdDataAddr = 7;
const WdResetOff = 0x20;
const WdDrive1 = 0x02;
const WdSideUpper = 0x04;
const WdSeekVerify12ms = 0x10 | 0x04 | 0x01;
const WdReadSector = 0x80;
const WdWriteDeletedSector = 0xa1;
const WdForceInterrupt = 0xd0;
const WdNoSpinUp = 0x08;
const WdRestore = 0x00;
const WdSeek = 0x10;
const WdStepOut = 0x60;
const MasterControlAddr = 4;
const MasterFmDrive0 = 0x25;
const PastAbortCycles = 1000;
const PastCommandCycles = 4_000_000;

describe("FdcPanel", () => {
    let scheduler;
    let visualiser;

    beforeEach(() => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        scheduler = new Scheduler();
        visualiser = { zoomToHead: vi.fn() };
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await teardownDom();
    });

    function panelFor(Fdc, model) {
        const cpu = fake6502(model);
        const drives = [0, 1].map((id) => new DiscDrive(id, scheduler, cpu.peripheralCyclesPerSecond));
        const fdc =
            Fdc === WdFdc
                ? new WdFdc(cpu, scheduler, drives, WdFdcVariant.wd1770)
                : new IntelFdc(cpu, scheduler, drives);
        const panel = new FdcPanel({
            cpu: { fdc },
            arrangement: new PanelArrangement(() => window.localStorage),
            visualiser,
            storage: () => window.localStorage,
        });
        return { fdc, panel };
    }

    const meanings = (name) => decodedMeanings("fdc-panel", name);
    const part = (className) => document.querySelector(`#fdc-panel .${className}`);
    const logLines = () => [...part("fdc-log").children].map((line) => line.textContent);
    const toggles = () =>
        [...part("fdc-log-heading").querySelectorAll(".decoded-bit")].map((toggle) => {
            const on = toggle.classList.contains("lit");
            expect(toggle.getAttribute("aria-pressed")).toBe(String(on));
            return `${on ? "+" : "-"}${toggle.textContent}`;
        });

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
        expect(meanings("HEAD")).toEqual(["drive 0 side 0 track 0", "-selected", "-spinning"]);
    });

    it("shows the 1770's registers, with the status bits named for the kind of command in force", () => {
        const { fdc, panel } = panelFor(WdFdc);
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

    it("shows whether a 1770 write puts a deleted data mark", () => {
        const { fdc, panel } = panelFor(WdFdc);
        fdc.write(WdControlAddr, WdResetOff | WdDrive1);
        fdc.write(WdCommandAddr, WdWriteDeletedSector);
        panel.update();
        expect(meanings("CMD")).toEqual(["write sector", "-multi", "-settle", "+deleted"]);
    });

    it.each([
        {
            Fdc: IntelFdc,
            run: (fdc) => {
                fdc.write(IntelCommandAddr, IntelReadDriveStatus);
                fdc.write(IntelCommandAddr, IntelReadSpecialRegister);
                fdc.write(IntelParamAddr, IntelDriveOutRegister);
                fdc.write(IntelCommandAddr, IntelReadData);
                for (const param of [5, 2, OneSectorOf256]) fdc.write(IntelParamAddr, param);
            },
            lines: [
                "read drive status, drive 0 (head on track 0)  cmd 6c",
                "result &81  status 10 result 81",
                "read special register, drive 0: register &23 (head on track 0)  cmd 7d params 23",
                "result &40  status 10 result 40",
                "read data, drive 0: track 5, sector 2, 1 × 256 bytes (head on track 0)  cmd 53 params 05 02 21",
            ],
        },
        {
            Fdc: WdFdc,
            run: (fdc) => {
                fdc.write(WdControlAddr, WdResetOff | WdDrive1);
                fdc.write(WdSectorAddr, 3);
                fdc.write(WdDataAddr, 2);
                fdc.write(WdCommandAddr, WdSeekVerify12ms);
            },
            lines: [
                "control, drive 1, side 0, MFM  wrote 22",
                "sector register set to 3",
                "seek, drive 1, side 0: to track 2 from 0, verify, 12 ms steps (head on track 0)  cmd 15 tr 0 sr 3 dr 2",
            ],
        },
    ])(
        "logs the $Fdc.name's commands spelt out, with the bytes behind them, only while asked",
        ({ Fdc, run, lines }) => {
            const { fdc } = panelFor(Fdc);
            run(fdc);
            expect(logLines().filter((line) => !line.startsWith("warning"))).toEqual([]);
            fdc.powerOnReset();
            part("fdc-log-commands").click();
            run(fdc);
            expect(logLines().filter((line) => !line.startsWith("warning"))).toEqual(lines);
            expect(part("fdc-log").querySelector(".fdc-log-raw").textContent).toMatch(/^(cmd|wrote) /);
        },
    );

    it("logs a 1770 command's result, naming what went wrong", () => {
        const { fdc } = panelFor(WdFdc);
        fdc.drives[1].setDisc(blankDisc());
        part("fdc-log-commands").click();
        fdc.write(WdControlAddr, WdResetOff | WdDrive1);
        fdc.write(WdCommandAddr, WdReadSector | WdNoSpinUp);
        scheduler.polltime(PastCommandCycles);
        expect(logLines()).toContainEqual(expect.stringMatching(/^done: not found {2}status /));
    });

    it.each([
        {
            Fdc: IntelFdc,
            start: (fdc) => {
                fdc.drives[0].setDisc(blankDisc());
                fdc.write(IntelCommandAddr, IntelSpecify);
                for (const param of IntelSpecifyLikeDfs) fdc.write(IntelParamAddr, param);
                fdc.write(IntelCommandAddr, IntelWriteSpecialRegister);
                fdc.write(IntelParamAddr, IntelDriveOutRegister);
                fdc.write(IntelParamAddr, IntelLoadHeadOnDrive0);
                scheduler.polltime(PastCommandCycles);
                // The drive status is latched: the second read sees the drive ready.
                fdc.write(IntelCommandAddr, IntelReadDriveStatus);
                fdc.write(IntelCommandAddr, IntelReadDriveStatus);
                fdc.write(IntelCommandAddr, IntelReadData);
                for (const param of [5, 2, OneSectorOf256]) fdc.write(IntelParamAddr, param);
            },
            line: /^state: idle → \w/,
        },
        {
            Fdc: WdFdc,
            start: (fdc) => {
                fdc.write(WdControlAddr, WdResetOff | WdDrive1);
                fdc.write(WdCommandAddr, WdReadSector);
            },
            line: /^state: idle → spin up wait {2}tr 0 sr 1 dr 0$/,
        },
    ])("logs the $Fdc.name's state changes by name while asked", ({ Fdc, start, line }) => {
        const { fdc } = panelFor(Fdc);
        part("fdc-log-states").click();
        expect(fdc.logStateChanges).toBe(true);
        start(fdc);
        scheduler.polltime(PastCommandCycles);
        expect(logLines()).toContainEqual(expect.stringMatching(line));
    });

    it("logs the drives' motors and heads while asked, the head against its stop among them", () => {
        const { fdc } = panelFor(WdFdc);
        fdc.drives[1].setDisc(blankDisc());
        fdc.drives[1].tracksPerStep = 2;
        part("fdc-log-drives").click();
        fdc.write(WdControlAddr, WdResetOff | WdDrive1);
        fdc.write(WdDataAddr, 2);
        for (const command of [WdSeek, WdRestore, WdStepOut]) {
            fdc.write(WdCommandAddr, command | WdNoSpinUp);
            scheduler.polltime(PastCommandCycles);
        }
        const driveLines = logLines().filter((line) => line.startsWith("drive 1"));
        expect(driveLines).toEqual([
            "drive 1: motor on",
            "drive 1: stepping 2 tracks in, 6 ms a step",
            "drive 1: head on track 2",
            "drive 1: motor off",
            "drive 1: motor on",
            "drive 1: stepping 2 tracks out, 6 ms a step",
            "drive 1: head on track 0",
            "drive 1: motor off",
            "drive 1: motor on",
            "drive 1: head against its stop at track 0",
            "drive 1: motor off",
        ]);
        part("fdc-log-drives").click();
        part("fdc-log-clear").click();
        fdc.write(WdCommandAddr, WdSeek | WdNoSpinUp);
        scheduler.polltime(PastCommandCycles);
        expect(logLines()).toEqual([]);
    });

    it("logs the warnings the controller logs unasked", () => {
        const { fdc } = panelFor(IntelFdc);
        fdc.write(IntelUnwiredAddr, 0x01);
        expect(logLines()).toEqual(["warning: write to unwired register: &0003=&01"]);
        expect(part("fdc-log").firstElementChild.classList).toContain("fdc-log-warning");
        expect(console.warn).toHaveBeenCalledWith("8271: write to unwired register: &0003=&01");
    });

    it("logs the control byte a Master wrote, decoded as its latch is wired", () => {
        const { fdc } = panelFor(WdFdc, findModel("Master"));
        part("fdc-log-commands").click();
        fdc.write(MasterControlAddr, MasterFmDrive0);
        expect(logLines()).toEqual(["control, drive 0, side 0, FM  wrote 25"]);
    });

    it("remembers which logs are on for the next visit", async () => {
        panelFor(IntelFdc);
        expect(toggles()).toEqual(["-commands", "-state changes", "-drives"]);
        part("fdc-log-commands").click();
        part("fdc-log-drives").click();
        const saved = window.localStorage.getItem("fdcLog");
        await teardownDom();
        window.localStorage.setItem("fdcLog", saved);
        const { fdc } = panelFor(IntelFdc);
        expect(toggles()).toEqual(["+commands", "-state changes", "+drives"]);
        expect(fdc.logCommands).toBe(true);
    });

    it("shows only the lines with the filter's text in them, and copies those", async () => {
        const { fdc } = panelFor(IntelFdc);
        part("fdc-log-commands").click();
        fdc.write(IntelCommandAddr, IntelSeek);
        fdc.write(IntelParamAddr, 3);
        fdc.write(IntelCommandAddr, IntelReadDriveStatus);
        const filter = part("fdc-log-filter");
        filter.value = "SEEK";
        filter.dispatchEvent(new Event("input"));
        const shown = () =>
            [...part("fdc-log").children].filter((line) => !line.hidden).map((line) => line.textContent);
        expect(shown()).toEqual(["seek, drive 0: track 3 (head on track 0)  cmd 69 params 03"]);
        fdc.write(IntelCommandAddr, IntelSeek);
        fdc.write(IntelParamAddr, 4);
        expect(shown()).toHaveLength(2);
        expect(part("fdc-log-copy").hidden).toBe(true);
        const writeText = vi.fn(() => Promise.resolve());
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        part("fdc-log-copy").click();
        expect(writeText).toHaveBeenCalledWith(shown().join("\n"));
        filter.focus();
        filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(filter.value).toBe("");
        expect(document.activeElement).not.toBe(filter);
        expect(shown().length).toBeGreaterThan(2);
    });

    it("counts an 8271's drive as selected only while load head lets its select through", () => {
        const { fdc, panel } = panelFor(IntelFdc);
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
        const { fdc: saved } = panelFor(Fdc);
        select(saved);
        const state = saved.snapshotState();
        await teardownDom();
        const { fdc, panel } = panelFor(Fdc);
        fdc.restoreState(state);
        panel.update();
        expect(meanings("HEAD")[0]).toMatch(/^drive 1 /);
    });

    it("shows the head on the disc of the drive last selected, even if it came and went while the panel was not drawn", () => {
        const { fdc, panel } = panelFor(WdFdc);
        fdc.write(WdControlAddr, WdResetOff | WdDrive1);
        fdc.write(WdControlAddr, WdResetOff);
        panel.update();
        expect(meanings("HEAD")).toContain("-selected");
        expect(meanings("HEAD")[0]).toMatch(/^drive 1 /);
        part("fdc-zoom").click();
        expect(visualiser.zoomToHead).toHaveBeenCalledWith(1);
    });
});
