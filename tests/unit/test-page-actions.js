// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageActions } from "../../src/web/page-actions.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

describe("PageActions", () => {
    let deps;
    let page;

    beforeEach(() => {
        domFromIndexHtml("header-bar", "audio-warning", "info", "download-filestore-link");
        deps = {
            loop: { isRunning: vi.fn(() => true), setEmulationLead: vi.fn() },
            processor: { reset: vi.fn(), sysvia: { hasAnyKeyDown: vi.fn(() => false) }, filestore: null },
            keyboard: { clearKeys: vi.fn() },
            audioHandler: { setWindowFocused: vi.fn((focused) => (focused ? 20 : 0)) },
            rewindUI: { reset: vi.fn() },
            modals: { show: vi.fn() },
            parsedQuery: {},
            version: "1.2.3",
        };
    });

    afterEach(() => {
        page.dispose();
        return teardownDom();
    });

    const make = () => (page = new PageActions(deps));
    const click = (id) => {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true });
        document.getElementById(id).dispatchEvent(event);
        return event;
    };

    it("reveals what the page keeps hidden until the script has run", () => {
        expect(document.querySelectorAll(".initially-hidden").length).toBeGreaterThan(0);
        make();
        expect(document.querySelectorAll(".initially-hidden")).toHaveLength(0);
    });

    it("stamps the version on the about dialog", () => {
        make();
        expect(document.getElementById("jsbeeb-version").textContent).toBe("Version 1.2.3");
    });

    describe("the reset menu", () => {
        it("hard resets the machine and forgets the rewind history", () => {
            make();
            expect(click("hard-reset").defaultPrevented).toBe(true);
            expect(deps.rewindUI.reset).toHaveBeenCalledTimes(1);
            expect(deps.processor.reset).toHaveBeenCalledWith(true);
        });

        it("soft resets the machine alone", () => {
            make();
            expect(click("soft-reset").defaultPrevented).toBe(true);
            expect(deps.rewindUI.reset).not.toHaveBeenCalled();
            expect(deps.processor.reset).toHaveBeenCalledWith(false);
        });
    });

    describe("the filestore download", () => {
        it("does nothing on a machine without a filestore", () => {
            const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
            make();
            click("download-filestore-link");
            expect(anchorClick).not.toHaveBeenCalled();
        });

        it("saves the filestore's disc image", () => {
            vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:scsi"), revokeObjectURL: vi.fn() });
            const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
                this.dataset.clicked = `${this.download} from ${this.href}`;
            });
            deps.processor.filestore = { scsi: new Uint8Array([1, 2, 3]) };
            make();
            click("download-filestore-link");
            expect(anchorClick).toHaveBeenCalledTimes(1);
            expect(anchorClick.mock.contexts[0].dataset.clicked).toBe("scsi.dat from blob:scsi");
        });
    });

    describe("focus", () => {
        it("lets go of the keys and takes the unfocused audio lead when the window blurs", () => {
            make();
            window.dispatchEvent(new Event("blur"));
            expect(deps.keyboard.clearKeys).toHaveBeenCalledTimes(1);
            expect(deps.audioHandler.setWindowFocused).toHaveBeenCalledWith(false);
            expect(deps.loop.setEmulationLead).toHaveBeenCalledWith(0);
        });

        it("takes the focused audio lead back when the window focuses", () => {
            make();
            window.dispatchEvent(new Event("focus"));
            expect(deps.audioHandler.setWindowFocused).toHaveBeenCalledWith(true);
            expect(deps.loop.setEmulationLead).toHaveBeenCalledWith(20);
        });
    });

    describe("leaving the page", () => {
        const beforeUnload = () => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event;
        };

        it("warns when a key is held while running, since a shortcut probably caused this", () => {
            deps.processor.sysvia.hasAnyKeyDown.mockReturnValue(true);
            make();
            expect(beforeUnload().defaultPrevented).toBe(true);
        });

        it("lets a stopped machine, or one with no key down, go quietly", () => {
            make();
            expect(beforeUnload().defaultPrevented).toBe(false);
            deps.processor.sysvia.hasAnyKeyDown.mockReturnValue(true);
            deps.loop.isRunning.mockReturnValue(false);
            expect(beforeUnload().defaultPrevented).toBe(false);
        });
    });

    describe("drops", () => {
        it("refuses drops anywhere but the drop zone", () => {
            make();
            const over = new Event("dragover", { cancelable: true, bubbles: true });
            over.dataTransfer = { dropEffect: "copy" };
            document.body.dispatchEvent(over);
            expect(over.defaultPrevented).toBe(true);
            expect(over.dataTransfer.dropEffect).toBe("none");
            const drop = new Event("drop", { cancelable: true, bubbles: true });
            document.body.dispatchEvent(drop);
            expect(drop.defaultPrevented).toBe(true);
        });
    });

    describe("dialogs the URL asks for", () => {
        it("opens the about and terms dialogs when named", () => {
            deps.parsedQuery = { about: true, "pp-tos": true };
            make();
            expect(deps.modals.show).toHaveBeenCalledWith("info");
            expect(deps.modals.show).toHaveBeenCalledWith("pp-tos");
        });

        it("opens nothing otherwise", () => {
            make();
            expect(deps.modals.show).not.toHaveBeenCalled();
        });
    });
});
