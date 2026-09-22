// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BitshiftersArchive } from "../../src/bitshifters.js";
import { bytesResponse, manifestResponse } from "./helpers.js";

const SiteBase = "https://bitshifters.github.io/content";

const entry = (overrides = {}) => ({
    path: "bs-paradroid.ssd",
    title: "Paradroid",
    publisher: "Bitshifters",
    authors: "Kieran",
    year: 2026,
    type: "Game",
    machine: "Master",
    url: "https://bitshifters.github.io/posts/prods/bs-paradroid.html",
    ...overrides,
});

const archive = () => new BitshiftersArchive();

describe("BitshiftersArchive", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("hands the manifest's entries back as the catalogue, as the site lists them", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(manifestResponse([entry({ title: "Zebra" }), entry({ title: "Apple" })]));
        const catalogue = await archive().catalogue();
        expect(catalogue.map((file) => file.title)).toEqual(["Zebra", "Apple"]);
        expect(fetchSpy).toHaveBeenCalledWith(`${SiteBase}/manifest.json`);
    });

    it("rejects the catalogue when the manifest is missing or malformed", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 404 });
        await expect(archive().catalogue()).rejects.toThrow("404");
        vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        await expect(archive().catalogue()).rejects.toThrow("missing files array");
    });

    it("only fetches the manifest once, even when it is empty", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifestResponse([]));
        const subject = archive();
        await subject.catalogue();
        await subject.catalogue();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("fetches the manifest once for everyone asking while it is on its way", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifestResponse([entry()]));
        const subject = archive();
        const [first, second] = await Promise.all([subject.catalogue(), subject.catalogue()]);
        expect(first).toBe(second);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("tries the manifest again after a failure", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({ ok: false, status: 503 });
        const subject = archive();
        await expect(subject.catalogue()).rejects.toThrow("503");
        fetchSpy.mockResolvedValueOnce(manifestResponse([entry()]));
        expect((await subject.catalogue()).map((file) => file.title)).toEqual(["Paradroid"]);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("keeps the directories of a nested path while escaping its parts", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(url).toBe(`${SiteBase}/demos/2026/a%20b%23c.ssd`);
            return bytesResponse(new Uint8Array([1]));
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        expect(await archive().fetch("demos/2026/a b#c.ssd")).toEqual(new Uint8Array([1]));
    });

    it("returns the fetched image as bytes, untouched, from the path the manifest gave", async () => {
        const ssd = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(url).toBe(`${SiteBase}/ghouls-revenge-v1.10.ssd`);
            return bytesResponse(ssd);
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        expect(await archive().fetch("ghouls-revenge-v1.10.ssd")).toEqual(ssd);
    });

    it("throws when a disc is missing so the caller can report it", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 404 });
        vi.spyOn(console, "log").mockImplementation(() => {});
        await expect(archive().fetch("nope.ssd")).rejects.toThrow("404");
    });

    it("can be pointed at another prefix for testing", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifestResponse([]));
        await new BitshiftersArchive("https://example.com/test").catalogue();
        expect(fetchSpy).toHaveBeenCalledWith("https://example.com/test/manifest.json");
    });
});
