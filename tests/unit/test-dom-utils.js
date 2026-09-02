// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadBlob, downloadDriveData } from "../../src/dom-utils.js";
import { teardownDom } from "./helpers.js";

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
});
