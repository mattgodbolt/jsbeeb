import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { StairwayToHell } from "../../src/sth.js";
import { bytesResponse, describeManifestCatalogue, manifestResponse } from "./helpers.js";

const ARCHIVE_BASE = "https://bbc.xania.org/archive/sth";
const __dirname = dirname(fileURLToPath(import.meta.url));

describe("StairwayToHell", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reads the disc catalogue from the disk manifest, sorted", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(url).toBe(`${ARCHIVE_BASE}/diskimages/manifest.json`);
            return manifestResponse([
                { path: "Cheats/CHT_ChuckieEgg-ExtraColours.zip", size: 9992, mtime: null },
                { path: "Acornsoft/Elite.zip", size: 12345, mtime: null },
            ]);
        });
        expect(await new StairwayToHell().catalogue()).toEqual([
            "Acornsoft/Elite.zip",
            "Cheats/CHT_ChuckieEgg-ExtraColours.zip",
        ]);
    });

    it("uses the tape directory when constructed for tapes", async () => {
        const seen = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            seen.push(url);
            return manifestResponse([{ path: "AnF/ChuckieEgg.zip", size: 1, mtime: null }]);
        });
        expect(await new StairwayToHell({ tapes: true }).catalogue()).toEqual(["AnF/ChuckieEgg.zip"]);
        expect(seen).toEqual([`${ARCHIVE_BASE}/tapeimages/manifest.json`]);
    });

    it("URL-encodes path components when fetching a file", async () => {
        // An empty archive, which the unzip rejects; only the URL matters here.
        const seen = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            seen.push(url);
            return bytesResponse(new Uint8Array());
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(new StairwayToHell().fetch("Daxis/Daxis[droids]-demo.zip")).rejects.toMatchObject({
            loadFailure: "bad_image",
        });
        expect(seen).toEqual([`${ARCHIVE_BASE}/diskimages/Daxis/Daxis%5Bdroids%5D-demo.zip`]);
    });

    it("returns the name of the file found inside the zip, not the zip's own path", async () => {
        const zip = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-ssd.zip")));
        vi.spyOn(globalThis, "fetch").mockResolvedValue(bytesResponse(zip));
        vi.spyOn(console, "log").mockImplementation(() => {});
        const { name, data } = await new StairwayToHell().fetch("Mandarin/Lancelot.zip");
        expect(name).toBe("test.ssd");
        expect(data instanceof Uint8Array).toBe(true);
        expect(String.fromCharCode(...data)).toBe("This is a test SSD file\n");
    });

    describeManifestCatalogue(() => new StairwayToHell(), `${ARCHIVE_BASE}/diskimages/manifest.json`);
});
