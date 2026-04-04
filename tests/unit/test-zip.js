import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as utils from "../../src/utils.js";

import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
});
