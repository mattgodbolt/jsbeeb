// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findModel } from "../../src/models.js";
import { Scheduler } from "../../src/scheduler.js";
import { SysVia, UserVia } from "../../src/via.js";
import { decodedPanel } from "../../src/web/decoded-registers.js";
import { DebugGroup, MenuGroup, PanelArrangement } from "../../src/web/floating-panel.js";
import { StartEdge } from "../../src/web/panel-layout.js";
import { SysViaPanel } from "../../src/web/sysvia-panel.js";
import { UserViaPanel } from "../../src/web/uservia-panel.js";
import { decodedMeanings, decodedRow, fakeAnimationFrames, teardownDom, ViaRegister } from "./helpers.js";

const { T1CL, T1CH, T2CL, T2CH } = ViaRegister;
const TicksPerMicrosecond = 2;

describe("decoded panels", () => {
    let scheduler;
    let arrangement;
    let frames;

    beforeEach(() => {
        frames = fakeAnimationFrames();
        scheduler = new Scheduler();
        arrangement = new PanelArrangement(() => window.localStorage);
        arrangement.followMachine(() => scheduler.epoch);
    });

    afterEach(teardownDom);

    it("are among the debugger's panels, drawn as they open and then once a frame only while open and the machine moves on", () => {
        const draw = vi.fn();
        const { floating } = decodedPanel({
            id: "device",
            title: "Device",
            feature: "device",
            place: () => ({ x: StartEdge, y: StartEdge }),
            minSize: { w: 100, h: 100 },
            arrangement,
            draw,
        });
        expect(arrangement.panelsIn(DebugGroup)).toEqual([floating]);
        expect(arrangement.listed().map(({ title, menuGroup }) => [title, menuGroup])).toEqual([
            ["Device", MenuGroup.hardware],
        ]);
        floating.open();
        expect(draw).toHaveBeenCalledTimes(1);
        frames.run();
        expect(draw).toHaveBeenCalledTimes(1);
        scheduler.polltime(1);
        frames.run();
        expect(draw).toHaveBeenCalledTimes(2);
        floating.close();
        expect(frames.pending).toBe(0);
    });

    describe.each([
        { Panel: SysViaPanel, id: "sysvia" },
        { Panel: UserViaPanel, id: "uservia" },
    ])("the $id panel", ({ Panel, id }) => {
        let via;
        let panel;

        beforeEach(() => {
            const cpu = {
                sysvia: new SysVia({ interrupt: 0 }, scheduler, {
                    video: { setScreenHwScroll: () => {} },
                    soundChip: { updateSlowDataBus: () => {} },
                    cmos: { writeControl: () => {}, read: () => 0xff },
                    isMaster: false,
                    initialLayout: "physical",
                }),
                uservia: new UserVia({ interrupt: 0 }, scheduler, false, { read: () => 0xff, write: () => {} }),
            };
            via = cpu[id];
            panel = new Panel({ cpu, arrangement });
        });

        const meanings = (name) => decodedMeanings(`${id}-panel`, name);

        it("is made for a BBC or a Master, not for an Atom, whose CPU carries VIAs it never wires up", () => {
            const fits = (name) => Panel.fits({ model: findModel(name) });
            expect([fits("B-DFS1.2"), fits("Master"), fits("Atom")]).toEqual([true, true, false]);
        });

        it("is filled before it opens, so that it is laid out at its size", () => {
            expect(panel.floating.isOpen).toBe(false);
            expect(meanings("IFR")).toHaveLength(8);
        });

        it("gives the timers in cycles once a frame as a program would read them, without clearing the flag", () => {
            panel.floating.open();
            via.write(T1CL, 0x10);
            via.write(T1CH, 0x27);
            via.write(T2CL, 0xe8);
            via.write(T2CH, 0x03);
            scheduler.polltime(100 * TicksPerMicrosecond);
            frames.run();
            expect(decodedRow(`${id}-panel`, "T1L").querySelector(".decoded-hex").textContent).toBe("2710");
            expect(meanings("T1L")).toEqual(["10000 cycles"]);
            expect(meanings("T1C")).toEqual(["9901 cycles"]);
            expect(meanings("T2C")).toEqual(["901 cycles"]);
            scheduler.polltime(1000 * TicksPerMicrosecond);
            frames.run();
            expect(meanings("IFR")).toContain("+T2");
            scheduler.polltime(1);
            frames.run();
            expect(meanings("IFR")).toContain("+T2");
        });
    });
});
