import { describe, expect, it, vi } from "vitest";

import { HfeSource } from "../../src/web/hfe-source.js";

describe("HfeSource", () => {
    const make = () => {
        const media = { addSource: vi.fn(), addLister: vi.fn() };
        const source = new HfeSource({ media });
        return { media, source };
    };

    it("hands the loader a fetcher for the archive", async () => {
        const { media, source } = make();
        const registered = Object.fromEntries(media.addSource.mock.calls);
        expect(Object.keys(registered)).toEqual(["hfe"]);
        vi.spyOn(source.archive, "fetch").mockResolvedValue("hfe bytes");
        await expect(registered.hfe("Games/ELITE.hfe")).resolves.toBe("hfe bytes");
        expect(source.archive.fetch).toHaveBeenCalledWith("Games/ELITE.hfe");
    });

    it("lists the archive for the media window", async () => {
        const { media, source } = make();
        vi.spyOn(source.archive, "catalogue").mockResolvedValue([
            { path: "Games/ELITE.hfe", title: "Elite", publisher: "Acornsoft", provenance: "captured" },
        ]);
        const [name, lister] = media.addLister.mock.calls[0];
        expect(name).toBe("hfe");
        expect(await lister()).toEqual([
            expect.objectContaining({ ref: "hfe:Games/ELITE.hfe", kind: "disc", title: "Elite", source: "hfe" }),
        ]);
    });
});
