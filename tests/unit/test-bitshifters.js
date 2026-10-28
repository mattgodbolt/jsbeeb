// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BitshiftersArchive } from "../../src/bitshifters.js";
import { bytesResponse, describeManifestCatalogue, manifestResponse } from "./helpers.js";

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

    it("doesn't refetch an archive that is legitimately empty", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifestResponse([]));
        const subject = archive();
        await subject.catalogue();
        await subject.catalogue();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    describeManifestCatalogue(
        () => new BitshiftersArchive("https://example.com/test"),
        "https://example.com/test/manifest.json",
    );
});
