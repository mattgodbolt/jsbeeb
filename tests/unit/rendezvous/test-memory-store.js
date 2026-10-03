import { describe, expect, it } from "vitest";

import { createMemoryStore } from "../../../rendezvous/memory-store.js";

describe("memory store", () => {
    it("writes conditionally only over an absent or expired item", async () => {
        const store = createMemoryStore();
        expect(await store.put({ room: "r", entry: "e", expires: 100, v: 1 }, { unlessLiveAt: 50 })).toBe(true);
        expect(await store.put({ room: "r", entry: "e", expires: 200, v: 2 }, { unlessLiveAt: 99 })).toBe(false);
        expect(await store.put({ room: "r", entry: "e", expires: 200, v: 3 }, { unlessLiveAt: 100 })).toBe(true);
        expect(await store.get("r", "e")).toEqual({ room: "r", entry: "e", expires: 200, v: 3 });
    });

    it("writes with ifPresent only over an item that is there", async () => {
        const store = createMemoryStore();
        expect(await store.put({ room: "r", entry: "e", expires: 1 }, { ifPresent: true })).toBe(false);
        await store.put({ room: "r", entry: "e", expires: 1 });
        expect(await store.put({ room: "r", entry: "e", expires: 2 }, { ifPresent: true })).toBe(true);
        expect((await store.get("r", "e")).expires).toBe(2);
    });

    it("keeps expired items until they are deleted", async () => {
        const store = createMemoryStore();
        await store.put({ room: "r", entry: "e", expires: 1 });
        expect(await store.query("r")).toEqual([{ room: "r", entry: "e", expires: 1 }]);
        await store.delete("r", "e");
        expect(await store.get("r", "e")).toBeUndefined();
        expect(await store.query("r")).toEqual([]);
    });

    it("hands out copies", async () => {
        const store = createMemoryStore();
        await store.put({ room: "r", entry: "e", expires: 1 });
        (await store.get("r", "e")).expires = 99;
        expect((await store.get("r", "e")).expires).toBe(1);
    });
});
