// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { StairwayToHell } from "../../src/sth.js";

const ARCHIVE_HOST = "bbc.xania.org";
const ARCHIVE_PREFIX = "archive/sth";

function makeManifestResponse(files) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 1, files }),
    };
}

function makeOk(body = new Uint8Array()) {
    return {
        ok: true,
        status: 200,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
}

describe("StairwayToHell", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("populates the disc catalog from the disk manifest", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(url).toBe(`http://${ARCHIVE_HOST}/${ARCHIVE_PREFIX}/diskimages/manifest.json`);
            return makeManifestResponse([
                { path: "Acornsoft/Elite.zip", size: 12345, mtime: null },
                { path: "Cheats/CHT_ChuckieEgg-ExtraColours.zip", size: 9992, mtime: null },
            ]);
        });

        let received;
        const sth = new StairwayToHell(
            () => {},
            (cat) => (received = cat),
            () => {},
            false,
        );
        await sth.populate();

        expect(received).toEqual(["Acornsoft/Elite.zip", "Cheats/CHT_ChuckieEgg-ExtraColours.zip"]);
    });

    it("uses the tape directory when constructed with tape=true", async () => {
        const seen = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            seen.push(url);
            return makeManifestResponse([]);
        });

        const sth = new StairwayToHell(
            () => {},
            () => {},
            () => {},
            true,
        );
        await sth.populate();

        expect(seen).toEqual([`http://${ARCHIVE_HOST}/${ARCHIVE_PREFIX}/tapeimages/manifest.json`]);
    });

    it("invokes the error callback when the manifest fetch fails", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 503 });
        vi.spyOn(console, "error").mockImplementation(() => {});

        const onError = vi.fn();
        const onCat = vi.fn();
        const sth = new StairwayToHell(() => {}, onCat, onError, false);
        await sth.populate();

        expect(onError).toHaveBeenCalledOnce();
        expect(onCat).not.toHaveBeenCalled();
    });

    it("rejects manifests that don't have a files array", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ schemaVersion: 1 }),
        });
        vi.spyOn(console, "error").mockImplementation(() => {});

        const onError = vi.fn();
        const sth = new StairwayToHell(
            () => {},
            () => {},
            onError,
            false,
        );
        await sth.populate();
        expect(onError).toHaveBeenCalledOnce();
    });

    it("URL-encodes path components when fetching a file", async () => {
        // Empty zip archive — utils.unzipDiscImage will reject, which is fine;
        // we only care that fetch was called with the right URL.
        const seen = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            seen.push(url);
            return makeOk(new Uint8Array());
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});

        const sth = new StairwayToHell(
            () => {},
            () => {},
            () => {},
            false,
        );
        await expect(sth.fetch("Unreleased/Daxis[droids]-demo.zip")).rejects.toBeDefined();

        expect(seen).toEqual([
            `http://${ARCHIVE_HOST}/${ARCHIVE_PREFIX}/diskimages/Unreleased/Daxis%5Bdroids%5D-demo.zip`,
        ]);
    });
});
