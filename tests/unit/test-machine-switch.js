// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MachineSwitch, leaveForNextPage, reloadAsMachine, takeFromLastPage } from "../../src/web/machine-switch.js";
import { MachineRequirements, requirementOf } from "../../src/web/media-catalogue.js";
import { findModel } from "../../src/models.js";
import { fakeUrlState, sentEvents, stubNavigation, teardownDom, toasts } from "./helpers.js";

const PendingSwitchKey = "jsbeeb-pending-switch";

afterEach(teardownDom);

describe("MachineSwitch", () => {
    let deps;

    beforeEach(() => {
        deps = {
            model: findModel("B-DFS1.2"),
            processor: { hasTube: false },
            urlState: stubNavigation(fakeUrlState("?disc1=elite.ssd&autoboot&autotype=RUN&loadBasic=a.bas&patch=@1")),
            modals: { confirm: vi.fn() },
        };
    });

    const make = () => new MachineSwitch(deps);
    const paradroid = { ref: "bitshifters:bs-paradroid.ssd", title: "Paradroid", requires: MachineRequirements.Master };
    const twinhead = { ref: "bitshifters:twinhead.ssd", title: "Twinhead", requires: MachineRequirements.MasterTurbo };
    const drive0 = { urlParamsFor: (ref) => ({ disc: undefined, disc1: ref }) };
    const nulaDemo = {
        ref: "github:a/b/nula.ssd",
        title: "NuLA demo",
        requires: requirementOf({ needs: ["VideoNuLA"] }),
    };

    it("fits what a disc needs, keeping the model when the disc names none", async () => {
        await make().switchFor(nulaDemo, drive0, { boot: true });
        expect(deps.urlState.navigatedTo).toBe("https://bbc.example/?disc1=github:a/b/nula.ssd&autoboot&hasVideoNula");
        expect(sessionStorage.getItem(PendingSwitchKey)).toBe(
            "Switched to a BBC B with 8271 (DFS 1.2) and a VideoNuLA for NuLA demo",
        );
    });

    it.each([
        ["a disc that names no machine", true, {}, { ref: "sth:Elite.zip", title: "Elite" }],
        ["a Master disc on a B", false, {}, paradroid],
        ["a Master disc on a Master with ADFS", false, { model: "MasterADFS" }, paradroid],
        ["a Master disc on a Master", true, { model: "Master" }, paradroid],
        ["a Master disc on a Master with a Tube", false, { model: "Master", hasTube: true }, paradroid],
        ["a Master Turbo disc on a Master", false, { model: "Master" }, twinhead],
        ["a Master Turbo disc on a Master with a Tube", true, { model: "Master", hasTube: true }, twinhead],
        ["a NuLA disc with no fittings given", false, {}, nulaDemo],
        ["a NuLA disc without a NuLA fitted", false, { fitted: { hasVideoNula: false } }, nulaDemo],
        ["a NuLA disc with a NuLA fitted", true, { fitted: { hasVideoNula: true } }, nulaDemo],
    ])("finds %s satisfied: %s", (_, satisfied, { model = "B-DFS1.2", hasTube = false, fitted }, d) => {
        Object.assign(deps, { model: findModel(model), processor: { hasTube }, fitted });
        expect(make().satisfies(d)).toBe(satisfied);
    });

    it("reloads for a boot without asking: the machine named, the disc, the boot, and nothing else the page did", async () => {
        await expect(make().switchFor(twinhead, drive0, { boot: true })).resolves.toBe(true);
        expect(deps.urlState.navigatedTo).toBe(
            "https://bbc.example/?disc1=bitshifters:twinhead.ssd&autoboot&model=Master&coProcessor",
        );
        expect(window.location.hash).toBe("#navigated");
        expect(deps.modals.confirm).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(PendingSwitchKey)).toBe(
            "Switched to a BBC Master 128 with a 65C102 co-processor for Twinhead",
        );
        make().announce();
        expect(toasts()).toEqual([expect.stringContaining("Switched to a BBC Master 128 with a 65C102 co-processor")]);
        expect(sessionStorage.getItem(PendingSwitchKey)).toBeNull();
        make().announce();
        expect(toasts()).toHaveLength(1);
    });

    it("names a disc of the user's own to analytics only by its source", async () => {
        const sent = sentEvents();
        await make().switchFor({ ...paradroid, ref: "gd:1AbC/Mine.ssd" }, drive0, { boot: true });
        expect(sent("media")).toEqual([{ type: "switchMachine", label: "gdrive" }]);
    });

    it("asks before reloading for a plain load: a yes reloads with no boot and no notice, a no stays put", async () => {
        deps.modals.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await expect(make().switchFor(paradroid, drive0, { boot: false })).resolves.toBe(false);
        expect(deps.urlState.navigatedTo).toBeNull();
        await expect(make().switchFor(paradroid, drive0, { boot: false })).resolves.toBe(true);
        expect(deps.modals.confirm).toHaveBeenCalledWith(
            "Paradroid needs a BBC Master 128. Switch machine? The emulator restarts.",
            "Switch machine",
            "Load it here",
        );
        expect(deps.urlState.navigatedTo).toBe("https://bbc.example/?disc1=bitshifters:bs-paradroid.ssd&model=Master");
        expect(sessionStorage.getItem(PendingSwitchKey)).toBeNull();
    });

    it("replaces the page in the history for a switch made at startup, and pushes for one picked", async () => {
        const entries = window.history.length;
        await make().switchFor(paradroid, drive0, { boot: true, replace: true });
        expect(window.history.length).toBe(entries);
        await make().switchFor(paradroid, drive0, { boot: true });
        expect(window.history.length).toBe(entries + 1);
    });
});

describe("reloading as another machine", () => {
    const pageThatDidThings = () =>
        stubNavigation(
            fakeUrlState(
                "?disc1=elite.ssd&autoboot&autochain&autorun&autotype=RUN&loadBasic=a.bas&embedBasic=1&patch=@1",
            ),
        );

    it("keeps the page's media and drops what it did at startup, unless the caller asks again", () => {
        const urlState = pageThatDidThings();
        reloadAsMachine(urlState, { model: "Master", coProcessor: true });
        expect(urlState.navigatedTo).toBe("https://bbc.example/?disc1=elite.ssd&model=Master&coProcessor");
        reloadAsMachine(urlState, { model: "Master", coProcessor: false, autoboot: true });
        expect(urlState.navigatedTo).toBe("https://bbc.example/?disc1=elite.ssd&autoboot&model=Master");
    });

    it("hands a value to the next page exactly once", () => {
        expect(takeFromLastPage("jsbeeb-test")).toBeNull();
        leaveForNextPage("jsbeeb-test", "");
        expect(takeFromLastPage("jsbeeb-test")).toBe("");
        expect(takeFromLastPage("jsbeeb-test")).toBeNull();
    });
});
