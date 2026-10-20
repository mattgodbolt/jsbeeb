// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuiltInImages } from "../../src/web/media-loader.js";
import { RunMode } from "../../src/web/emulation-loop.js";
import { MachineSwitch } from "../../src/web/machine-switch.js";
import { MediaSlots } from "../../src/web/media-slots.js";
import { MachineRequirements } from "../../src/web/media-catalogue.js";
import { findModel } from "../../src/models.js";
import { hostAndRun, startAsTheUrlAsks, startupPlan } from "../../src/web/startup.js";
import { fakeUrlState, stubNavigation, teardownDom } from "./helpers.js";

const paradroid = { ref: "bitshifters:bs-paradroid.ssd", title: "Paradroid", requires: MachineRequirements.Master };

afterEach(teardownDom);

describe("startupPlan", () => {
    it("loads the page's own disc when the URL names none, and boots nothing", () => {
        expect(startupPlan({})).toEqual({
            media: {
                discImage: BuiltInImages[0].file,
                discImageInUrl: false,
                secondDiscImage: null,
                tape: undefined,
                mmcImage: undefined,
                loadBasic: undefined,
                embedBasic: undefined,
                basicNeedsRun: false,
            },
            autoboot: "none",
            autoType: "",
            bootMode: "none",
            mayNeedAnotherModel: false,
            patch: undefined,
        });
    });

    it("loads the media the URL names, disc1 over the older disc", () => {
        const { media } = startupPlan({ disc: "old.ssd", disc1: "a.ssd", disc2: "b.ssd", tape: "t.uef", mmc: "m.zip" });
        expect(media).toMatchObject({
            discImage: "a.ssd",
            discImageInUrl: true,
            secondDiscImage: "b.ssd",
            tape: "t.uef",
            mmcImage: "m.zip",
        });
    });

    it.each([
        [{ autoboot: "" }, "boot", ""],
        [{ autochain: "" }, "chain", ""],
        [{ autorun: "" }, "run", ""],
        [{ autotype: "PRINT 1\n" }, "type", "PRINT 1\n"],
    ])("takes %j as the autoboot %s", (query, autoboot, autoType) => {
        expect(startupPlan(query)).toMatchObject({ autoboot, autoType, bootMode: autoboot });
    });

    it("lets a BASIC program in the URL be the boot, running it when asked to autorun", () => {
        expect(startupPlan({ loadBasic: "a.bas", autoboot: "" })).toMatchObject({
            autoboot: "",
            bootMode: "basic",
            mayNeedAnotherModel: false,
            media: { loadBasic: "a.bas", basicNeedsRun: false },
        });
        expect(startupPlan({ loadBasic: "a.bas", autorun: "" })).toMatchObject({
            autoboot: "",
            media: { basicNeedsRun: true },
        });
    });

    it("checks the boot disc's machine only for a boot from a link that names no model", () => {
        expect(startupPlan({ disc: "a.ssd", autoboot: "" }).mayNeedAnotherModel).toBe(true);
        expect(startupPlan({ disc: "a.ssd", autoboot: "", model: "B" }).mayNeedAnotherModel).toBe(false);
        expect(startupPlan({ disc: "a.ssd", autotype: "x" }).mayNeedAnotherModel).toBe(false);
    });
});

describe("startAsTheUrlAsks", () => {
    const start = (query, { model = "B-DFS1.2", bootDisc = null, restoresIntoDebugger = false } = {}) => {
        const log = [];
        const loop = {
            mode: RunMode.paused,
            go: () => log.push("go"),
        };
        const urlState = stubNavigation(fakeUrlState(`?${query}`));
        const deps = {
            bootDisc: Promise.resolve(bootDisc),
            machineSwitch: new MachineSwitch({
                model: findModel(model),
                processor: { hasTube: false },
                urlState,
                modals: {},
            }),
            drive0: new MediaSlots({ urlState }).drive(0),
            renderer: "webgl",
            noteStart: (details) => log.push(["noteStart", details]),
            autoBoot: {
                boot: () => log.push("boot"),
                type: (text) => log.push(["type", text]),
                chainTape: () => log.push("chain"),
                runTape: () => log.push("run"),
            },
            dbgr: { setPatch: (patch) => log.push(["patch", patch]) },
            snapshots: {
                restorePendingState: async () => {
                    log.push("restore");
                    if (restoresIntoDebugger) loop.mode = RunMode.debugging;
                },
            },
            loop,
        };
        const started = startAsTheUrlAsks(startupPlan(urlState.params), deps);
        return { started, log, urlState };
    };

    it("notes the start, boots as asked, applies the patch, restores a pending state, then runs", async () => {
        const { started, log } = start("disc=elite.ssd&autoboot&patch=@1");
        await expect(started).resolves.toBe(true);
        expect(log).toEqual([
            ["noteStart", { boot_mode: "boot", renderer: "webgl" }],
            "boot",
            ["patch", "@1"],
            "restore",
            "go",
        ]);
    });

    it.each([
        ["autotype=RUN", "type", ["type", "RUN"]],
        ["autochain", "chain", "chain"],
        ["autorun", "run", "run"],
    ])("for %s does only %j", async (query, bootMode, action) => {
        const { started, log } = start(query);
        await started;
        expect(log).toEqual([["noteStart", { boot_mode: bootMode, renderer: "webgl" }], action, "restore", "go"]);
    });

    it("leaves the machine paused when the restored state was saved in the debugger", async () => {
        const { started, log } = start("", { restoresIntoDebugger: true });
        await expect(started).resolves.toBe(true);
        expect(log).toEqual([["noteStart", { boot_mode: "none", renderer: "webgl" }], "restore"]);
    });

    it("reloads as the machine the boot disc needs, replacing the page in the history, and starts nothing here", async () => {
        const entries = window.history.length;
        const { started, log, urlState } = start("disc1=bitshifters:bs-paradroid.ssd&autoboot", {
            bootDisc: paradroid,
        });
        await expect(started).resolves.toBe(false);
        expect(urlState.navigatedTo).toBe(
            "https://bbc.example/?disc1=bitshifters:bs-paradroid.ssd&autoboot&model=Master",
        );
        expect(window.history.length).toBe(entries);
        expect(log).toEqual([]);
    });

    it("boots the disc here when the machine already meets what it needs", async () => {
        const { started, log, urlState } = start("disc1=bitshifters:bs-paradroid.ssd&autoboot", {
            model: "Master",
            bootDisc: paradroid,
        });
        await expect(started).resolves.toBe(true);
        expect(urlState.navigatedTo).toBeNull();
        expect(log).toEqual([["noteStart", { boot_mode: "boot", renderer: "webgl" }], "boot", "restore", "go"]);
    });
});

describe("hostAndRun", () => {
    it("runs the machine once a session has started, and leaves it paused when none did", async () => {
        const runs = [];
        const loop = { go: () => runs.push("go") };
        const session = { room: "a-b-c" };
        await expect(hostAndRun(loop, async () => null)("matt")).resolves.toBeNull();
        expect(runs).toEqual([]);
        const named = [];
        const host = async (name) => (named.push(name), session);
        await expect(hostAndRun(loop, host)("matt")).resolves.toBe(session);
        expect(named).toEqual(["matt"]);
        expect(runs).toEqual(["go"]);
    });
});
