import { describe, it, expect } from "vitest";
import * as fs from "fs";

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { ungzip } from "../../src/archive.js";

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

async function gzipMember(text) {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts) {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

async function testOneFile(file) {
    const compressed = new Uint8Array(fs.readFileSync(`${file}.gz`));
    const expected = new Uint8Array(fs.readFileSync(file));
    expect(await ungzip(compressed)).toEqual(expected);
}

describe("gzip tests", function () {
    for (let fileIndex = 1; ; fileIndex++) {
        let file = join(__dirname, "gzip", `test-${fileIndex}`);
        if (!fs.existsSync(file)) break;
        it("handles test case " + file, () => testOneFile(file));
    }

    it("should handle single-member gzip", async () => {
        const result = await ungzip(helloWorldMember);
        expect(new TextDecoder().decode(result)).toBe("hello world");
    });

    it("should concatenate the members of a multi-member gzip", async () => {
        const result = await ungzip(repeatMember(3));
        expect(new TextDecoder().decode(result)).toBe("hello worldhello worldhello world");
    });

    it("should concatenate members of differing contents", async () => {
        const members = await Promise.all(["first ", "second ", "third"].map(gzipMember));
        const result = await ungzip(concat(members));
        expect(new TextDecoder().decode(result)).toBe("first second third");
    });

    it("should reject a multi-member gzip with a truncated final member", async () => {
        const truncated = repeatMember(2).subarray(0, helloWorldMember.length + 20);
        await expect(ungzip(truncated)).rejects.toThrow();
    });

    it("should reject a corrupted payload", async () => {
        const corrupted = helloWorldMember.slice();
        corrupted[24] ^= 0x01;
        await expect(ungzip(corrupted)).rejects.toThrow(/Unable to ungzip: incorrect data check/);
    });

    it("should reject a corrupted member in the middle of a multi-member gzip", async () => {
        const corrupted = repeatMember(3);
        corrupted[helloWorldMember.length + 24] ^= 0x01;
        await expect(ungzip(corrupted)).rejects.toThrow(/Unable to ungzip/);
    });

    it("should accept a member followed by trailing zeros", async () => {
        const padded = new Uint8Array(helloWorldMember.length + 8);
        padded.set(helloWorldMember);
        expect(new TextDecoder().decode(await ungzip(padded))).toBe("hello world");
    });

    it("should reject non-gzip data", async () => {
        const notGzip = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
        await expect(ungzip(notGzip)).rejects.toThrow();
    });
});
