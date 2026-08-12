import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as utils from "../../src/utils.js";

import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readZip(name) {
    return new Uint8Array(fs.readFileSync(join(__dirname, "zip", name)));
}

// Flips one bit in the first entry's data, leaving the stored CRC32 intact.
function corruptFirstEntry(zipData, offsetIntoData) {
    const nameLen = zipData[26] | (zipData[27] << 8);
    const extraLen = zipData[28] | (zipData[29] << 8);
    const corrupted = zipData.slice();
    corrupted[30 + nameLen + extraLen + offsetIntoData] ^= 0x01;
    return corrupted;
}

describe("zip tests", function () {
    it("should unzip SSD files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-ssd.zip")));
        const result = await utils.unzipDiscImage(zipData);

        expect(result.name).toBe("test.ssd");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a test SSD file\n");
    });

    it("should unzip ADFS files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-adf.zip")));
        const result = await utils.unzipDiscImage(zipData);

        expect(result.name).toBe("test.adf");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a test ADF file\n");
    });

    it("should unzip HFE files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-hfe.zip")));
        const result = await utils.unzipDiscImage(zipData);

        expect(result.name).toBe("test.hfe");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a test HFE file\n");
    });

    it("should unzip ROM files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-rom.zip")));
        const result = await utils.unzipRomImage(zipData);

        expect(result.name).toBe("test.rom");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a test ROM file\n");
    });

    it("should handle ZIP with multiple files by picking the first compatible one", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-mixed.zip")));
        const result = await utils.unzipDiscImage(zipData);

        // Should get the first compatible file (order may vary)
        expect(result.name === "test.ssd" || result.name === "test.rom").toBeTruthy();
        expect(result.data instanceof Uint8Array).toBeTruthy();
    });

    it("should throw error for ZIP with no compatible files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-ssd.zip")));

        await expect(utils.unzipRomImage(zipData)).rejects.toThrow(/Couldn't find any compatible files/);
    });

    it("should handle deflate-compressed ZIP files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-deflated.zip")));
        const result = await utils.unzipDiscImage(zipData);

        expect(result.name).toBe("test.ssd");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a deflate-compressed test SSD file\n");
    });

    it("should throw for unsupported compression method", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-bzip2.zip")));

        await expect(utils.unzipDiscImage(zipData)).rejects.toThrow(/Unsupported ZIP compression method/);
    });

    it("should throw for truncated/corrupt ZIP files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-truncated.zip")));

        await expect(utils.unzipDiscImage(zipData)).rejects.toThrow(/Not a ZIP file/);
    });

    it("should throw for non-ZIP data", async () => {
        const notZip = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

        await expect(utils.unzipDiscImage(notZip)).rejects.toThrow(/Not a ZIP file/);
    });

    it("should throw for a stored entry whose data does not match its CRC32", async () => {
        const zipData = corruptFirstEntry(readZip("test-ssd.zip"), 0);

        await expect(utils.unzipDiscImage(zipData)).rejects.toThrow(/Corrupt ZIP entry test\.ssd: CRC32 mismatch/);
    });

    it("should throw for a deflated entry that inflates cleanly to the wrong bytes", async () => {
        const zipData = corruptFirstEntry(readZip("test-deflated.zip"), 5);

        await expect(utils.unzipDiscImage(zipData)).rejects.toThrow(/Corrupt ZIP entry test\.ssd: CRC32 mismatch/);
    });

    it("should throw for a deflated entry whose stream is damaged beyond inflating", async () => {
        const zipData = corruptFirstEntry(readZip("test-deflated.zip"), 0);

        await expect(utils.unzipDiscImage(zipData)).rejects.toThrow(/Unable to inflate ZIP entry test\.ssd/);
    });
});
