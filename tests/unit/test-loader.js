import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadData, LoadFailures } from "../../src/loader.js";

const httpFailure = (status, loadFailure) => ({ message: expect.stringContaining(`http code ${status}`), loadFailure });

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

    it.each([
        ["an HTTP 404 as not_found", async () => new Response(null, { status: 404 }), httpFailure(404, "not_found")],
        ["an HTTP 500 as http", async () => new Response(null, { status: 500 }), httpFailure(500, "http")],
        [
            "a request that never got a response as a network failure",
            async () => Promise.reject(new TypeError("Failed to fetch")),
            { loadFailure: "network" },
        ],
    ])("fails %s", async (_, fetchResult, failure) => {
        vi.stubGlobal("fetch", vi.fn(fetchResult));
        await expect(loadData("https://example.com/a.ssd")).rejects.toMatchObject(failure);
    });
});

describe("loadData in a browser", () => {
    let respond;

    class FakeXhr {
        open(method, url) {
            this.url = url;
        }
        overrideMimeType() {}
        send() {
            respond(this);
        }
    }

    const browserLoadData = async () => {
        vi.stubGlobal("window", {});
        vi.stubGlobal("XMLHttpRequest", FakeXhr);
        vi.resetModules();
        return (await import("../../src/loader.js")).loadData;
    };

    afterEach(() => vi.unstubAllGlobals());

    const httpStatus = (status) => (xhr) => {
        xhr.status = status;
        xhr.onload();
    };

    it.each([
        ["an HTTP 404 as not_found", httpStatus(404), httpFailure(404, "not_found")],
        ["an HTTP 500 as http", httpStatus(500), httpFailure(500, "http")],
        [
            "a request that never got a response as a network failure",
            (xhr) => xhr.onerror(),
            { loadFailure: "network" },
        ],
    ])("fails %s", async (_, response, failure) => {
        respond = response;
        await expect((await browserLoadData())("https://example.com/a.ssd")).rejects.toMatchObject(failure);
    });
});

describe("LoadFailures", () => {
    const sources = readdirSync(new URL("../../src", import.meta.url), { recursive: true })
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8"))
        .join("\n");

    it.each(Object.keys(LoadFailures))("has %s raised somewhere", (key) => {
        expect(sources).toContain(`LoadFailures.${key}`);
    });
});
