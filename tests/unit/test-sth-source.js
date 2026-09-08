import { describe, expect, it, vi } from "vitest";

import { SthSource } from "../../src/web/sth-source.js";

describe("SthSource", () => {
    const make = () => {
        const media = { addSource: vi.fn(), addLister: vi.fn() };
        const source = new SthSource({ media });
        return { media, source };
    };

    it("hands the loader a fetcher for each catalogue", async () => {
        const { media, source } = make();
        const registered = Object.fromEntries(media.addSource.mock.calls);
        expect(Object.keys(registered).sort()).toEqual(["sth", "tapeSth"]);
        vi.spyOn(source.discs, "fetch").mockResolvedValue("disc bytes");
        vi.spyOn(source.tapes, "fetch").mockResolvedValue("tape bytes");
        await expect(registered.sth("Acornsoft/Elite.zip")).resolves.toBe("disc bytes");
        await expect(registered.tapeSth("AnF/Chuckie.zip")).resolves.toBe("tape bytes");
    });

    it("lists both catalogues for the media window, discs and tapes told apart", async () => {
        const { media, source } = make();
        vi.spyOn(source.discs, "catalogue").mockResolvedValue(["Acornsoft/Elite.zip"]);
        vi.spyOn(source.tapes, "catalogue").mockResolvedValue(["AnF/ChuckieEgg.zip"]);
        const [name, lister] = media.addLister.mock.calls[0];
        expect(name).toBe("sth");
        expect(await lister()).toEqual([
            expect.objectContaining({ ref: "sth:Acornsoft/Elite.zip", kind: "disc", title: "Elite" }),
            expect.objectContaining({ ref: "sth:AnF/ChuckieEgg.zip", kind: "tape", title: "ChuckieEgg" }),
        ]);
    });
});
