// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadBlob, downloadDriveData, PopupMenu, textButton } from "../../src/web/dom-utils.js";
import { pressKeepsFocus, teardownDom } from "./helpers.js";

describe("dom-utils", () => {
    describe("downloadBlob", () => {
        let clicked;

        beforeEach(() => {
            vi.useFakeTimers();
            clicked = [];
            vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
                clicked.push({ href: this.href, download: this.download, inDocument: this.isConnected });
            });
            vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-url");
            vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        });

        afterEach(teardownDom);

        it("clicks an anchor in the document with the given file name", () => {
            downloadBlob(new Blob(["data"]), "disc.ssd");
            expect(clicked).toEqual([{ href: "blob:test-url", download: "disc.ssd", inDocument: true }]);
        });

        it("keeps the object URL alive past the click so Safari can fetch it", () => {
            downloadBlob(new Blob(["data"]), "disc.ssd");
            expect(URL.revokeObjectURL).not.toHaveBeenCalled();
            vi.runAllTimers();
            expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-url");
        });

        it("leaves no anchor behind", () => {
            downloadBlob(new Blob(["data"]), "disc.ssd");
            expect(document.querySelector("a")).toBeNull();
        });
    });

    describe("downloadDriveData", () => {
        let clicked;

        beforeEach(() => {
            vi.useFakeTimers();
            clicked = [];
            vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
                clicked.push({ download: this.download, href: this.href });
            });
            vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:disc", revokeObjectURL: () => {} });
        });

        afterEach(teardownDom);

        it("names the file for the format it is in", () => {
            downloadDriveData(new Uint8Array([1, 2, 3]), "elite.ssd", ".hfe");
            expect(clicked).toEqual([{ download: "elite.hfe", href: "blob:disc" }]);
        });
    });

    describe("PopupMenu", () => {
        const OpenerLeft = 10;
        const OpenerTop = 100;
        const OpenerBottom = 120;
        const MenuHeight = 50;
        let opener, floating, built, popup;
        const menu = () => document.querySelector(".test-menu");
        const isOpen = () => !menu().hidden;

        beforeEach(() => {
            opener = textButton("opener", "Open", "");
            document.body.append(opener);
            vi.spyOn(opener, "getBoundingClientRect").mockReturnValue({
                left: OpenerLeft,
                top: OpenerTop,
                bottom: OpenerBottom,
            });
            vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(MenuHeight);
            floating = new EventTarget();
            built = 0;
            popup = new PopupMenu({
                opener,
                className: "test-menu",
                floating,
                build: () => {
                    built++;
                    return [textButton("choice", `choice ${built}`, "")];
                },
            });
        });

        afterEach(() => {
            popup.show(false);
            return teardownDom();
        });

        it("opens and closes on its opener, built afresh each time it opens", () => {
            opener.click();
            expect(isOpen()).toBe(true);
            expect(opener.getAttribute("aria-expanded")).toBe("true");
            opener.click();
            expect(isOpen()).toBe(false);
            expect(opener.getAttribute("aria-expanded")).toBe("false");
            popup.show(true);
            expect(menu().textContent).toBe("choice 2");
        });

        it("sits under its opener, or above it where there is no room below", () => {
            vi.stubGlobal("innerHeight", OpenerBottom + MenuHeight);
            opener.click();
            expect(menu().style.top).toBe(`${OpenerBottom}px`);
            opener.click();
            vi.stubGlobal("innerHeight", OpenerBottom + MenuHeight - 1);
            opener.click();
            expect(menu().style.top).toBe(`${OpenerTop - MenuHeight}px`);
        });

        it("keeps its buttons from focus, closing on a press elsewhere, its panel closing, or Escape alone", () => {
            opener.click();
            const choice = menu().querySelector("button");
            expect(pressKeepsFocus(choice)).toBe(true);
            expect(choice.tabIndex).toBe(-1);
            choice.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
            expect(isOpen()).toBe(true);
            document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
            expect(isOpen()).toBe(false);
            opener.click();
            floating.dispatchEvent(new Event("close"));
            expect(isOpen()).toBe(false);
            opener.click();
            const pageSaw = vi.fn();
            document.addEventListener("keydown", pageSaw);
            document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            document.removeEventListener("keydown", pageSaw);
            expect(isOpen()).toBe(false);
            expect(pageSaw).not.toHaveBeenCalled();
        });
    });
});
