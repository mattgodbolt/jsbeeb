// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MachineSwitch } from "../../src/web/machine-switch.js";
import { BitshiftersMachines } from "../../src/web/media-catalogue.js";
import { findModel } from "../../src/models.js";
import { fakeUrlState, stubNavigation, teardownDom, toasts } from "./helpers.js";

const PendingSwitchKey = "jsbeeb-pending-switch";

describe("MachineSwitch", () => {
    let deps;

    beforeEach(() => {
        deps = {
            model: findModel("B-DFS1.2"),
            processor: { hasTube: false },
            urlState: stubNavigation(fakeUrlState()),
            modals: { confirm: vi.fn() },
        };
    });

    afterEach(() => {
        window.history.replaceState(null, "", window.location.pathname);
        sessionStorage.clear();
        return teardownDom();
    });

    const make = () => new MachineSwitch(deps);
    const paradroid = { ref: "bitshifters:bs-paradroid.ssd", title: "Paradroid", requires: BitshiftersMachines.Master };
    const twinhead = { ref: "bitshifters:twinhead.ssd", title: "Twinhead", requires: BitshiftersMachines.MasterTurbo };
    const drive0 = { urlParamsFor: (ref) => ({ disc: undefined, disc1: ref }) };
    const drive1 = { urlParamsFor: (ref) => ({ disc2: ref }) };
    const navigated = () => window.location.hash === "#navigated";

    describe("whether the machine will do", () => {
        it("is satisfied by any disc that names no machine", () => {
            expect(make().satisfies({ ref: "sth:Elite.zip", title: "Elite" })).toBe(true);
        });

        it("holds the running model and its Tube against what the disc names", () => {
            expect(make().satisfies(paradroid)).toBe(false);
            deps.model = findModel("MasterADFS");
            expect(make().satisfies(paradroid)).toBe(true);
            expect(make().satisfies(twinhead)).toBe(false);
            deps.processor.hasTube = true;
            expect(make().satisfies(twinhead)).toBe(true);
        });
    });

    describe("switching for a disc that is to boot", () => {
        it("reloads with the machine, the disc and the boot in the URL, without asking", async () => {
            await expect(make().switchFor(paradroid, drive0, { boot: true })).resolves.toBe(true);
            expect(deps.urlState.navigatedTo).toBe(
                "https://bbc.example/?disc1=bitshifters:bs-paradroid.ssd&autoboot&model=Master",
            );
            expect(navigated()).toBe(true);
            expect(deps.modals.confirm).not.toHaveBeenCalled();
        });

        it("leaves word of the change for the page that comes up, which says it once", async () => {
            await make().switchFor(twinhead, drive0, { boot: true });
            expect(sessionStorage.getItem(PendingSwitchKey)).toBe(
                "Switched to a BBC Master 128 with a 65C102 co-processor for Twinhead",
            );
            make().announce();
            expect(toasts()).toEqual([
                expect.stringContaining("Switched to a BBC Master 128 with a 65C102 co-processor for Twinhead"),
            ]);
            expect(sessionStorage.getItem(PendingSwitchKey)).toBeNull();
        });

        it("asks for the co-processor when the disc needs one", async () => {
            await make().switchFor(twinhead, drive0, { boot: true });
            expect(deps.urlState.navigatedTo).toBe(
                "https://bbc.example/?disc1=bitshifters:twinhead.ssd&autoboot&model=Master&coProcessor",
            );
        });

        it("keeps a co-processor the page already has, and a Master of another filing system", async () => {
            deps.urlState = stubNavigation(fakeUrlState("?model=B&coProcessor"));
            await make().switchFor(paradroid, drive0, { boot: true });
            expect(deps.urlState.navigatedTo).toBe(
                "https://bbc.example/?model=Master&coProcessor&disc1=bitshifters:bs-paradroid.ssd&autoboot",
            );
            deps.model = findModel("MasterADFS");
            deps.urlState = stubNavigation(fakeUrlState("?model=MasterADFS"));
            await make().switchFor(twinhead, drive0, { boot: true });
            expect(deps.urlState.navigatedTo).toBe(
                "https://bbc.example/?model=MasterADFS&disc1=bitshifters:twinhead.ssd&autoboot&coProcessor",
            );
        });
    });

    describe("switching for a disc that is only to be loaded", () => {
        it("asks first, and reloads with the disc but no boot on a yes", async () => {
            deps.modals.confirm.mockResolvedValue(true);
            await expect(make().switchFor(paradroid, drive0, { boot: false })).resolves.toBe(true);
            expect(deps.modals.confirm).toHaveBeenCalledWith(
                "Paradroid needs a BBC Master 128. Switch machine? The emulator restarts.",
                "Switch machine",
                "Load it here",
            );
            expect(deps.urlState.navigatedTo).toBe(
                "https://bbc.example/?disc1=bitshifters:bs-paradroid.ssd&model=Master",
            );
            expect(navigated()).toBe(true);
            expect(sessionStorage.getItem(PendingSwitchKey)).toBeNull();
        });

        it("names the drive the disc was picked for, and takes the page's boot and typing out of the URL", async () => {
            deps.modals.confirm.mockResolvedValue(true);
            deps.urlState = stubNavigation(fakeUrlState("?disc1=elite.ssd&autoboot&autotype=RUN&autochain&autorun"));
            await make().switchFor(paradroid, drive1, { boot: false });
            expect(deps.urlState.navigatedTo).toBe(
                "https://bbc.example/?disc1=elite.ssd&disc2=bitshifters:bs-paradroid.ssd&model=Master",
            );
        });

        it("stays put on a no, leaving the disc to be loaded here", async () => {
            deps.modals.confirm.mockResolvedValue(false);
            await expect(make().switchFor(paradroid, drive0, { boot: false })).resolves.toBe(false);
            expect(deps.urlState.navigatedTo).toBeNull();
            expect(navigated()).toBe(false);
        });
    });

    it("has nothing to say on a page that was not switched to", () => {
        make().announce();
        expect(toasts()).toEqual([]);
    });
});
