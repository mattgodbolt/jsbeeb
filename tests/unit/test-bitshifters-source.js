import { afterEach, describe, expect, it, vi } from "vitest";

import { BitshiftersSource } from "../../src/web/bitshifters-source.js";

describe("BitshiftersSource", () => {
    afterEach(() => vi.restoreAllMocks());

    const make = () => {
        const media = { addSource: vi.fn(), addLister: vi.fn() };
        const source = new BitshiftersSource({ media });
        return { media, source };
    };

    it("hands the loader a fetcher for the site", async () => {
        const { media, source } = make();
        const registered = Object.fromEntries(media.addSource.mock.calls);
        expect(Object.keys(registered)).toEqual(["bitshifters"]);
        vi.spyOn(source.archive, "fetch").mockResolvedValue("ssd bytes");
        await expect(registered.bitshifters("bs-paradroid.ssd")).resolves.toBe("ssd bytes");
        expect(source.archive.fetch).toHaveBeenCalledWith("bs-paradroid.ssd");
    });

    it("lists the site's releases for the media window, each with its page", async () => {
        const { media, source } = make();
        vi.spyOn(source.archive, "catalogue").mockResolvedValue([
            {
                path: "bs-paradroid.ssd",
                title: "Paradroid",
                publisher: "Bitshifters",
                year: 2026,
                type: "Game",
                machine: "Master",
                url: "https://bitshifters.github.io/posts/prods/bs-paradroid.html",
            },
        ]);
        const [name, lister] = media.addLister.mock.calls[0];
        expect(name).toBe("bitshifters");
        expect(await lister()).toEqual([
            expect.objectContaining({
                ref: "bitshifters:bs-paradroid.ssd",
                kind: "disc",
                title: "Paradroid",
                source: "bitshifters",
                url: "https://bitshifters.github.io/posts/prods/bs-paradroid.html",
            }),
        ]);
    });

    describe("describing a reference", () => {
        const catalogue = [{ path: "bs-paradroid.ssd", title: "Paradroid", machine: "Master" }];

        it("finds the release a reference names in the catalogue", async () => {
            const { source } = make();
            vi.spyOn(source.archive, "catalogue").mockResolvedValue(catalogue);
            await expect(source.describe("bitshifters:bs-paradroid.ssd")).resolves.toMatchObject({
                ref: "bitshifters:bs-paradroid.ssd",
                title: "Paradroid",
                requires: { model: "Master" },
            });
        });

        it("has nothing for a path the catalogue does not list", async () => {
            const { source } = make();
            vi.spyOn(source.archive, "catalogue").mockResolvedValue(catalogue);
            await expect(source.describe("bitshifters:nope.ssd")).resolves.toBeNull();
        });

        it("has nothing for another source's reference, without fetching the catalogue", async () => {
            const { source } = make();
            const fetched = vi.spyOn(source.archive, "catalogue");
            await expect(source.describe("sth:Elite.zip")).resolves.toBeNull();
            expect(fetched).not.toHaveBeenCalled();
        });

        it("has nothing when the catalogue is out of reach, and says so on the console", async () => {
            const { source } = make();
            vi.spyOn(source.archive, "catalogue").mockRejectedValue(new Error("offline"));
            const log = vi.spyOn(console, "log").mockImplementation(() => {});
            await expect(source.describe("bitshifters:bs-paradroid.ssd")).resolves.toBeNull();
            expect(log).toHaveBeenCalledWith(expect.stringContaining("offline"));
        });
    });
});
