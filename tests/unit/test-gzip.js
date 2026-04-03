import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as utils from "../../src/utils.js";

import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function testOneFile(file) {
    const compressed = new Uint8Array(fs.readFileSync(`${file}.gz`));
    const expected = new Uint8Array(fs.readFileSync(file));
    expect(await utils.ungzip(compressed)).toEqual(expected);
}

describe("gzip tests", function () {
    for (let fileIndex = 1; ; fileIndex++) {
        let file = join(__dirname, "gzip", `test-${fileIndex}`);
        if (!fs.existsSync(file)) break;
        it("handles test case " + file, () => testOneFile(file));
    }

    it("should reject non-gzip data", async () => {
        const notGzip = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
        await expect(utils.ungzip(notGzip)).rejects.toThrow();
    });

    it("should handle single-member gzip", async () => {
        // Create a simple gzip buffer using CompressionStream
        const input = new TextEncoder().encode("hello world");
        const cs = new CompressionStream("gzip");
        const writer = cs.writable.getWriter();
        writer.write(input);
        writer.close();
        const reader = cs.readable.getReader();
        const chunks = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const compressed = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
            compressed.set(c, off);
            off += c.length;
        }

        const result = await utils.ungzip(compressed);
        expect(new TextDecoder().decode(result)).toBe("hello world");
    });
});
