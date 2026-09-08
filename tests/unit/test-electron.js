// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialise } from "../../src/app/electron.js";
import { teardownDom } from "./helpers.js";

describe("the Electron hooks", () => {
    let api;
    let deps;

    beforeEach(() => {
        api = {
            onLoadDisc: vi.fn(),
            onLoadTape: vi.fn(),
            onShowModal: vi.fn(),
            onAction: vi.fn(),
            onLoadState: vi.fn(),
            setTitle: vi.fn(),
            saveSettings: vi.fn(),
        };
        window.electronAPI = api;
        const slots = Object.assign(new EventTarget(), {
            drive: (index) => `drive ${index}`,
            deck: "the deck",
            load: vi.fn().mockResolvedValue("loaded"),
        });
        deps = {
            media: { slots },
            modals: { show: vi.fn() },
            actions: { media: vi.fn() },
        };
    });

    afterEach(() => {
        delete window.electronAPI;
        return teardownDom();
    });

    const loadDisc = (message) => {
        initialise(deps);
        return api.onLoadDisc.mock.calls[0][0](message);
    };
    const loadTape = (message) => {
        initialise(deps);
        return api.onLoadTape.mock.calls[0][0](message);
    };

    it("shows the modal the menu named, and runs the action it sent", () => {
        initialise(deps);
        api.onShowModal.mock.calls[0][0]({ modalId: "configuration" });
        expect(deps.modals.show).toHaveBeenCalledWith("configuration");
        api.onAction.mock.calls[0][0]({ actionId: "media" });
        expect(deps.actions.media).toHaveBeenCalled();
    });

    it("does nothing outside Electron", () => {
        delete window.electronAPI;
        initialise(deps);
        expect(api.onLoadDisc).not.toHaveBeenCalled();
    });

    it("loads the disc the menu named into its drive, known by its file name", async () => {
        await loadDisc({ drive: 1, path: "file:///discs/b.ssd" });
        expect(deps.media.slots.load).toHaveBeenCalledWith(
            "drive 1",
            expect.objectContaining({ ref: "file:///discs/b.ssd", kind: "disc", title: "b.ssd" }),
        );
    });

    it("loads the tape the menu named into the deck", async () => {
        await loadTape({ path: "file:///tapes/t.uef" });
        expect(deps.media.slots.load).toHaveBeenCalledWith(
            "the deck",
            expect.objectContaining({ ref: "file:///tapes/t.uef", kind: "tape" }),
        );
    });

    it("saves what a slot is known by as a setting once it settles", () => {
        initialise(deps);
        const slot = { busy: null, urlParams: () => ({ disc: undefined, disc1: "file:///discs/b.ssd" }) };
        deps.media.slots.dispatchEvent(new CustomEvent("changed", { detail: { slot } }));
        expect(api.saveSettings).toHaveBeenCalledWith({ disc: undefined, disc1: "file:///discs/b.ssd" });
        deps.media.slots.dispatchEvent(new CustomEvent("changed", { detail: { slot: { ...slot, busy: {} } } }));
        expect(api.saveSettings).toHaveBeenCalledTimes(1);
    });
});
