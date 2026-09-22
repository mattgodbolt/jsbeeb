import { describe, expect, it, vi } from "vitest";

import { BitshiftersSource } from "../../src/web/bitshifters-source.js";

describe("BitshiftersSource", () => {
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
});
