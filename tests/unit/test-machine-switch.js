// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MachineSwitch, leaveForNextPage, reloadAsMachine, takeFromLastPage } from "../../src/web/machine-switch.js";
import { MachineRequirements } from "../../src/web/media-catalogue.js";
import { findModel } from "../../src/models.js";
import { fakeUrlState, stubNavigation, teardownDom, toasts } from "./helpers.js";

const PendingSwitchKey = "jsbeeb-pending-switch";

afterEach(() => {
    window.history.replaceState(null, "", window.location.pathname);
    sessionStorage.clear();
    return teardownDom();
});

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

    it("is satisfied by a disc that names no machine, and otherwise only by that very machine, Tube included", () => {
        expect(make().satisfies({ ref: "sth:Elite.zip", title: "Elite" })).toBe(true);
        expect(make().satisfies(paradroid)).toBe(false);
        deps.model = findModel("MasterADFS");
        expect(make().satisfies(paradroid)).toBe(false);
        deps.model = findModel("Master");
        expect(make().satisfies(paradroid)).toBe(true);
        expect(make().satisfies(twinhead)).toBe(false);
        deps.processor.hasTube = true;
        expect(make().satisfies(twinhead)).toBe(true);
        expect(make().satisfies(paradroid)).toBe(false);
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

    it("pushes a history entry unless told to replace the page", () => {
        const urlState = pageThatDidThings();
        const entries = window.history.length;
        reloadAsMachine(urlState, { model: "Master" }, { replace: true });
        expect(window.history.length).toBe(entries);
        reloadAsMachine(urlState, { model: "Master" });
        expect(window.history.length).toBe(entries + 1);
    });

    it("hands a value to the next page exactly once", () => {
        expect(takeFromLastPage("jsbeeb-test")).toBeNull();
        leaveForNextPage("jsbeeb-test", "");
        expect(takeFromLastPage("jsbeeb-test")).toBe("");
        expect(takeFromLastPage("jsbeeb-test")).toBeNull();
    });
});
