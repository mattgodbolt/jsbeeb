import { describe, expect, it } from "vitest";

import { swapVdfsFolder } from "../../../src/app/vdfs-swap.js";

describe("changing the VDFS folder", () => {
    it("has the page hand over what it wrote, and the writes in flight finish, before the folder changes and the page starts again", async () => {
        const events = [];
        const writes = [new Promise((resolve) => setTimeout(resolve, 5)).then(() => events.push("write done"))];
        await swapVdfsFolder({
            flushPage: async () => events.push("page flushed"),
            inFlight: () => writes,
            changeFolder: () => events.push("folder changed"),
            loadPage: async () => events.push("page loaded"),
        });
        expect(events).toEqual(["page flushed", "write done", "folder changed", "page loaded"]);
    });

    it("goes on with a write that failed, since it is the old folder's to report", async () => {
        const events = [];
        await swapVdfsFolder({
            flushPage: async () => {},
            inFlight: () => [Promise.reject(new Error("disc full"))],
            changeFolder: () => events.push("folder changed"),
            loadPage: async () => events.push("page loaded"),
        });
        expect(events).toEqual(["folder changed", "page loaded"]);
    });
});
