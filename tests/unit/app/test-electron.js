// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachDesktopVdfs, desktopVdfsStore, initialise } from "../../../src/app/electron.js";
import { teardownDom } from "../helpers.js";

describe("the Electron hooks", () => {
    let api;
    let deps;
    let panels;
    let listed;

    beforeEach(() => {
        api = {
            onLoadDisc: vi.fn(),
            onLoadTape: vi.fn(),
            onShowModal: vi.fn(),
            onAction: vi.fn(),
            onLoadState: vi.fn(),
            setTitle: vi.fn(),
            saveSettings: vi.fn(),
            setPanels: vi.fn(),
            onTogglePanel: vi.fn(),
        };
        window.electronAPI = api;
        const slots = Object.assign(new EventTarget(), {
            drive: (index) => `drive ${index}`,
            deck: "the deck",
            load: vi.fn().mockResolvedValue("loaded"),
        });
        panels = Object.assign(new EventTarget(), { listed: () => listed });
        listed = [];
        deps = {
            panels,
            media: { slots },
            modals: { show: vi.fn() },
            actions: { media: vi.fn() },
            settings: new EventTarget(),
            loadStateFile: vi.fn(),
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

    it("tells the app's Debug menu the panels to list and which are open, and toggles the one it names", () => {
        const watches = { id: "watches", title: "Watches", menuGroup: "CPU", isOpen: false, toggle: vi.fn() };
        listed = [watches];
        initialise(deps);
        expect(api.setPanels).toHaveBeenLastCalledWith([
            { id: "watches", title: "Watches", menuGroup: "CPU", open: false },
        ]);
        watches.isOpen = true;
        panels.dispatchEvent(new Event("change"));
        expect(api.setPanels).toHaveBeenLastCalledWith([
            { id: "watches", title: "Watches", menuGroup: "CPU", open: true },
        ]);
        api.onTogglePanel.mock.calls[0][0]({ id: "watches" });
        expect(watches.toggle).toHaveBeenCalled();
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
            { entry: "menu" },
        );
    });

    it("loads the tape the menu named into the deck", async () => {
        await loadTape({ path: "file:///tapes/t.uef" });
        expect(deps.media.slots.load).toHaveBeenCalledWith(
            "the deck",
            expect.objectContaining({ ref: "file:///tapes/t.uef", kind: "tape" }),
            { entry: "menu" },
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

    describe("VDFS", () => {
        it("gives the machine the main process's store, when the app was started with a folder to serve", () => {
            const store = { find: vi.fn() };
            window.electronAPI = { vdfs: store };
            expect(desktopVdfsStore({ vdfs: true })).toBe(store);
        });

        it("gives nothing when there is no folder, or no app", () => {
            window.electronAPI = { vdfs: {} };
            expect(desktopVdfsStore({})).toBeNull();
            delete window.electronAPI;
            expect(desktopVdfsStore({ vdfs: true })).toBeNull();
        });

        describe("attached to the page", () => {
            const attached = () => {
                const host = {
                    flush: vi.fn(),
                    hold: vi.fn().mockResolvedValue(),
                    release: vi.fn(),
                    onWriteFailure: null,
                };
                window.electronAPI = { onVdfsFlush: vi.fn(), onVdfsChanged: vi.fn() };
                const notify = vi.fn();
                attachDesktopVdfs(host, { notify });
                return { host, notify };
            };

            it("holds the BBC, with its files written, when the main process is about to change folder", async () => {
                const { host } = attached();
                await window.electronAPI.onVdfsFlush.mock.calls[0][0]();
                expect(host.hold).toHaveBeenCalled();
                expect(host.release).not.toHaveBeenCalled();
            });

            it("lets the BBC go on when the main process says the folder has changed", async () => {
                const { host } = attached();
                await window.electronAPI.onVdfsFlush.mock.calls[0][0]();
                window.electronAPI.onVdfsChanged.mock.calls[0][0]();
                expect(host.release).toHaveBeenCalled();
            });

            it("lets the BBC go on anyway if the main process never does", async () => {
                vi.useFakeTimers();
                const { host } = attached();
                await window.electronAPI.onVdfsFlush.mock.calls[0][0]();
                vi.advanceTimersByTime(10000);
                expect(host.release).toHaveBeenCalled();
                vi.useRealTimers();
            });

            it("hands over what has been written when the page goes", () => {
                const { host } = attached();
                window.dispatchEvent(new Event("pagehide"));
                expect(host.flush).toHaveBeenCalled();
            });

            it("says so when the main process cannot keep what was written", () => {
                const { host, notify } = attached();
                host.onWriteFailure(new Error("disc full"));
                expect(notify).toHaveBeenCalledWith(expect.stringContaining("disc full"));
            });
        });
    });
});
