import { describe, expect, it } from "vitest";

import { drainVdfs, pageKeepsRunning, swapVdfsFolder } from "../../../src/app/vdfs-swap.js";

const later = (events, event) => new Promise((resolve) => setTimeout(resolve, 5)).then(() => events.push(event));

describe("draining VDFS", () => {
    it("has every page hand over what it wrote, and the writes in flight finish", async () => {
        const events = [];
        await drainVdfs({
            flushPages: () => [later(events, "first flushed"), later(events, "second flushed")],
            inFlight: () => [later(events, "write done")],
        });
        expect(events).toEqual(["first flushed", "second flushed", "write done"]);
    });

    it("goes on with a write that failed, since it is the old folder's to report", async () => {
        await expect(
            drainVdfs({ flushPages: () => [], inFlight: () => [Promise.reject(new Error("disc full"))] }),
        ).resolves.toBeUndefined();
    });
});

describe("the page that is running while the VDFS folder changes", () => {
    it.each([
        [true, "/new", true],
        [true, null, false],
        [false, "/new", false],
        [false, null, false],
    ])("when it was served: %s, and the folder is now %s, keeps running: %s", (wasServing, folder, keeps) => {
        expect(pageKeepsRunning({ wasServing, folder })).toBe(keeps);
    });
});

describe("changing the VDFS folder", () => {
    it("drains the old pages before the folder changes and the page starts again", async () => {
        const events = [];
        await swapVdfsFolder({
            flushPages: () => [later(events, "page flushed")],
            inFlight: () => [later(events, "write done")],
            changeFolder: () => events.push("folder changed"),
            loadPage: async () => events.push("page loaded"),
        });
        expect(events).toEqual(["page flushed", "write done", "folder changed", "page loaded"]);
    });
});
