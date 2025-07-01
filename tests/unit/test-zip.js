import { describe, it } from "vitest";
import assert from "assert";
import * as fs from "fs";
import * as utils from "../../src/utils.js";

import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("zip tests", function () {
    it("should unzip SSD files", () => {
        const zipData = new Uint8Array(fs.readFileSync(__dirname + "/zip/test-ssd.zip"));
        const result = utils.unzipDiscImage(zipData);

        assert.strictEqual(result.name, "test.ssd");
        assert.ok(result.data instanceof Uint8Array);

        // Convert to string to check content
        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        assert.strictEqual(content, "This is a test SSD file\n");
    });

    it("should unzip ROM files", () => {
        const zipData = new Uint8Array(fs.readFileSync(__dirname + "/zip/test-rom.zip"));
        const result = utils.unzipRomImage(zipData);

        assert.strictEqual(result.name, "test.rom");
        assert.ok(result.data instanceof Uint8Array);

        // Convert to string to check content
        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        assert.strictEqual(content, "This is a test ROM file\n");
    });

    it("should handle ZIP with multiple files by picking the first compatible one", () => {
        const zipData = new Uint8Array(fs.readFileSync(__dirname + "/zip/test-mixed.zip"));
        const result = utils.unzipDiscImage(zipData);

        // Should get the first compatible file (order may vary)
        assert.ok(result.name === "test.ssd" || result.name === "test.rom");
        assert.ok(result.data instanceof Uint8Array);
    });

    it("should throw error for ZIP with no compatible files", () => {
        // Create a simple ZIP with incompatible file
        const zipData = new Uint8Array(fs.readFileSync(__dirname + "/zip/test-ssd.zip"));

        assert.throws(() => {
            utils.unzipRomImage(zipData); // Try to extract ROM from SSD zip
        }, /Couldn't find any compatible files/);
    });
});
