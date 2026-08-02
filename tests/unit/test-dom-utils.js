// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadBlob } from "../../src/dom-utils.js";

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

        afterEach(() => {
            vi.restoreAllMocks();
            vi.useRealTimers();
        });

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
});
