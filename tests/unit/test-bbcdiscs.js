// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BbcDiscArchive,
    byTitle,
    describe as describeDisc,
    matches,
    Provenance,
    provenancesIn,
} from "../../src/bbcdiscs.js";

const ArchiveBase = "https://bbc.xania.org/archive/bbcdiscs";

const manifestResponse = (files) => ({
    ok: true,
    status: 200,
    json: async () => ({ schemaVersion: 1, files }),
});

const bytesResponse = (body) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});

const entry = (overrides = {}) => ({
    path: "B88911B2-BF6048A8.hfe",
    size: 88244,
    title: "Some Game",
    publisher: "Somesoft",
    disc: "D1DS",
    tracks: ["40", "80 (dual)"],
    variant: "1",
    ...overrides,
});

const archive = (onCat, onError = () => {}) => new BbcDiscArchive(() => {}, onCat, onError);

describe("describe", () => {
    it("spells out what tells two variants of a title apart", () => {
        expect(describeDisc(entry())).toEqual({
            title: "Some Game",
            publisher: "Somesoft",
            detail: "D1DS · 40, 80 (dual) · v1",
        });
    });

    it("leaves out the parts a disc doesn't have", () => {
        expect(describeDisc({ path: "x.hfe", title: "Bare", tracks: ["40"] })).toEqual({
            title: "Bare",
            publisher: "",
            detail: "40",
        });
    });

    it("falls back to the blob name when a disc has no title", () => {
        expect(describeDisc({ path: "DEADBEEF.hfe" }).title).toBe("DEADBEEF.hfe");
    });
});

describe("byTitle", () => {
    const sorted = (...files) =>
        files.sort(byTitle).map((f) => `${f.title} ${f.publisher ?? ""}${f.variant ?? ""}`.trim());

    it("orders by title rather than by publisher, which is how the catalogue arrives", () => {
        expect(sorted({ title: "Zork", publisher: "Acornsoft" }, { title: "Aviator", publisher: "Zenith" })).toEqual([
            "Aviator Zenith",
            "Zork Acornsoft",
        ]);
    });

    it("reads a number in a title as a number", () => {
        expect(sorted({ title: "Games Disc 10" }, { title: "Games Disc 2" })).toEqual([
            "Games Disc 2",
            "Games Disc 10",
        ]);
    });

    it("keeps a title's variants together and in order", () => {
        expect(
            sorted(
                { title: "Acheton", publisher: "Acornsoft", variant: "2" },
                { title: "Arcadians", publisher: "Acornsoft", variant: "1" },
                { title: "Acheton", publisher: "Acornsoft", variant: "1" },
            ),
        ).toEqual(["Acheton Acornsoft1", "Acheton Acornsoft2", "Arcadians Acornsoft1"]);
    });

    it("doesn't separate a title from its neighbours over case", () => {
        expect(sorted({ title: "elite" }, { title: "Doctor Who" }, { title: "Frak" })).toEqual([
            "Doctor Who",
            "elite",
            "Frak",
        ]);
    });

    it("falls back to the blob name for a disc with no title", () => {
        const untitled = { path: "AAAA0001.hfe" };
        const zork = { title: "Zork" };
        expect([zork, untitled].sort(byTitle)).toEqual([untitled, zork]);
    });
});

describe("BbcDiscArchive", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("hands the whole manifest entry to the catalogue, not just a name", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(url).toBe(`${ArchiveBase}/hfe/manifest.json`);
            return manifestResponse([entry({ provenance: Provenance.Reconstructed })]);
        });

        let received;
        await archive((cat) => (received = cat)).populate();
        expect(received).toEqual([entry({ provenance: Provenance.Reconstructed })]);
    });

    it("reads a disc published before provenance was recorded as a captured one", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(manifestResponse([entry()]));
        let received;
        await archive((cat) => (received = cat)).populate();
        expect(received[0].provenance).toBe(Provenance.Captured);
    });

    it("only fetches the manifest once across repeated opens", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifestResponse([entry()]));
        const subject = archive(() => {});
        await subject.populate();
        await subject.populate();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("doesn't refetch an archive that is legitimately empty", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifestResponse([]));
        const subject = archive(() => {});
        await subject.populate();
        await subject.populate();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("reports an error rather than throwing when the manifest is missing", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 404 });
        vi.spyOn(console, "error").mockImplementation(() => {});

        let failed = false;
        let received = null;
        await archive(
            (cat) => (received = cat),
            () => (failed = true),
        ).populate();

        expect(failed).toBe(true);
        expect(received).toBeNull();
    });

    it("rejects a manifest without a files array", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.spyOn(console, "error").mockImplementation(() => {});

        let failed = false;
        await archive(
            () => {},
            () => (failed = true),
        ).populate();
        expect(failed).toBe(true);
    });

    it("returns the fetched image as bytes, untouched", async () => {
        const hfe = new Uint8Array([0x48, 0x58, 0x43, 0x48, 0x46, 0x45, 0x56, 0x33, 0x01, 0x02]);
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(url).toBe(`${ArchiveBase}/hfe/B88911B2-BF6048A8.hfe`);
            return bytesResponse(hfe);
        });
        vi.spyOn(console, "log").mockImplementation(() => {});

        expect(await archive(() => {}).fetch("B88911B2-BF6048A8.hfe")).toEqual(hfe);
    });

    it("throws when a disc is missing so the caller can report it", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 404 });
        vi.spyOn(console, "log").mockImplementation(() => {});
        await expect(archive(() => {}).fetch("nope.hfe")).rejects.toThrow("404");
    });

    it("can be pointed at another prefix for testing", async () => {
        const seen = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            seen.push(url);
            return manifestResponse([]);
        });
        await new BbcDiscArchive(
            () => {},
            () => {},
            () => {},
            "https://example.com/test",
        ).populate();
        expect(seen).toEqual(["https://example.com/test/hfe/manifest.json"]);
    });
});

describe("provenancesIn", () => {
    it("reports each provenance the catalogue holds, once", () => {
        const captured = entry({ provenance: Provenance.Captured });
        expect(provenancesIn([captured, entry({ provenance: Provenance.Reconstructed }), captured])).toEqual([
            "captured",
            "reconstructed",
        ]);
    });
});

describe("matches", () => {
    const captured = entry({ title: "Elite", publisher: "Acornsoft", provenance: Provenance.Captured });
    const rebuilt = entry({ title: "Granny's Garden", publisher: "4mation", provenance: Provenance.Reconstructed });

    // An archive of one provenance offers no tickboxes, and a picker that then
    // showed nothing would be an empty list with no way to fix it.
    it("shows everything when no choice of provenance is being offered", () => {
        expect(matches(captured, "", null)).toBe(true);
        expect(matches(rebuilt, "", null)).toBe(true);
    });

    it("hides a disc whose provenance is not ticked", () => {
        const shown = new Set([Provenance.Captured]);
        expect(matches(captured, "", shown)).toBe(true);
        expect(matches(rebuilt, "", shown)).toBe(false);
    });

    it("searches the title, publisher and detail", () => {
        expect(matches(captured, "elite", null)).toBe(true);
        expect(matches(captured, "acornsoft", null)).toBe(true);
        expect(matches(captured, "d1ds", null)).toBe(true);
        expect(matches(captured, "zalaga", null)).toBe(false);
    });

    // It is a word the tickboxes control, and one common enough in a search box
    // that matching it would surface every rebuilt disc for "re".
    it("does not treat the provenance as something to search for", () => {
        expect(matches(rebuilt, "reconstructed", null)).toBe(false);
        expect(matches(rebuilt, "re", null)).toBe(false);
    });
});
