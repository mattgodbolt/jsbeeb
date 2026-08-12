import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as utils from "../../src/utils.js";

import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// "hello world" gzip-compressed with gzip(1): echo -n "hello world" | gzip
// prettier-ignore
const helloWorldMember = new Uint8Array([
    0x1f, 0x8b, 0x08, 0x08, 0xc1, 0x3b, 0xd0, 0x69, 0x00, 0x03, 0x74, 0x65,
    0x73, 0x74, 0x2d, 0x73, 0x69, 0x6e, 0x67, 0x6c, 0x65, 0x00, 0xcb, 0x48,
    0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01, 0x00, 0x85,
    0x11, 0x4a, 0x0d, 0x0b, 0x00, 0x00, 0x00,
]);

function repeatMember(times) {
    const result = new Uint8Array(helloWorldMember.length * times);
    for (let i = 0; i < times; ++i) result.set(helloWorldMember, i * helloWorldMember.length);
    return result;
}

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

    it("should handle single-member gzip", async () => {
        const result = await utils.ungzip(helloWorldMember);
        expect(new TextDecoder().decode(result)).toBe("hello world");
    });

    it("should concatenate the members of a multi-member gzip", async () => {
        const result = await utils.ungzip(repeatMember(3));
        expect(new TextDecoder().decode(result)).toBe("hello worldhello worldhello world");
    });

    it("should reject a multi-member gzip with a truncated final member", async () => {
        const truncated = repeatMember(2).subarray(0, helloWorldMember.length + 20);
        await expect(utils.ungzip(truncated)).rejects.toThrow();
    });

    it("should reject non-gzip data", async () => {
        const notGzip = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
        await expect(utils.ungzip(notGzip)).rejects.toThrow();
    });
});
