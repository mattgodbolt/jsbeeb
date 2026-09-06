import { afterEach, describe, expect, it, vi } from "vitest";

import { loadData } from "../../src/loader.js";

describe("loadData in node", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("reads a bare path from public", async () => {
        const data = await loadData("roms/os.rom");
        expect(data.length).toBe(16384);
    });

    it("reads a file: URL as the file it names", async () => {
        const data = await loadData(new URL("../../public/roms/os.rom", import.meta.url).href);
        expect(data.length).toBe(16384);
    });

    it("fetches a URL", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
        );
        expect(await loadData("https://example.com/a.ssd")).toEqual(new Uint8Array([1, 2, 3]));
        expect(fetch).toHaveBeenCalledWith("https://example.com/a.ssd");
    });

    it("reports a URL that is not there", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(null, { status: 404 })),
        );
        await expect(loadData("https://example.com/nosuch.ssd")).rejects.toThrow("http code 404");
    });
});
