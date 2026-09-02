import { describe, expect, it } from "vitest";
import * as fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
    crc32,
    createZipBlob,
    replaceOrAddExtension,
    ungzip,
    unzip,
    unzipDiscImage,
    unzipRomImage,
} from "../../src/archive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("crc32", () => {
    it("should return 0 for empty input", () => {
        expect(crc32(new Uint8Array(0))).toBe(0);
    });

    it("should compute correct CRC-32 for known input", () => {
        // CRC-32 of "123456789" is 0xCBF43926
        const data = new TextEncoder().encode("123456789");
        expect((crc32(data) >>> 0).toString(16)).toBe("cbf43926");
    });

    it("should differ for different inputs", () => {
        const a = crc32(new Uint8Array([1, 2, 3]));
        const b = crc32(new Uint8Array([1, 2, 4]));
        expect(a).not.toBe(b);
    });
});

describe("createZipBlob and unzip round-trip", () => {
    it("should create a valid ZIP that unzip can extract", async () => {
        const blob = createZipBlob([
            { name: "hello.txt", data: new TextEncoder().encode("Hello!") },
            { name: "dir/nested.bin", data: new Uint8Array([0xca, 0xfe]) },
        ]);
        expect(blob).toBeInstanceOf(Blob);

        const buf = new Uint8Array(await blob.arrayBuffer());
        const files = await unzip(buf);

        expect(Object.keys(files)).toHaveLength(2);
        expect(new TextDecoder().decode(files["hello.txt"])).toBe("Hello!");
        expect(files["dir/nested.bin"]).toEqual(new Uint8Array([0xca, 0xfe]));
    });

    it("should handle empty file list", () => {
        const blob = createZipBlob([]);
        expect(blob).toBeInstanceOf(Blob);
        expect(blob.size).toBe(22); // just the EOCD
    });

    it("should handle empty file data", async () => {
        const blob = createZipBlob([{ name: "empty", data: new Uint8Array(0) }]);
        const files = await unzip(new Uint8Array(await blob.arrayBuffer()));
        expect(files["empty"]).toEqual(new Uint8Array(0));
    });
});

describe("replaceOrAddExtension", function () {
    it("swaps the extension a name has", function () {
        expect(replaceOrAddExtension("elite.ssd", ".hfe")).toBe("elite.hfe");
    });

    it("adds one to a name without any", function () {
        expect(replaceOrAddExtension("scsi", ".dat")).toBe("scsi.dat");
    });

    it("only touches the last extension", function () {
        expect(replaceOrAddExtension("game.disc.ssd", ".dsd")).toBe("game.disc.dsd");
    });
});

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
        const result = await unzipDiscImage(zipData);

        expect(result.name).toBe("test.ssd");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a test SSD file\n");
    });

    it("should unzip ADFS files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-adf.zip")));
        const result = await unzipDiscImage(zipData);

        expect(result.name).toBe("test.adf");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a test ADF file\n");
    });

    it("should unzip HFE files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-hfe.zip")));
        const result = await unzipDiscImage(zipData);

        expect(result.name).toBe("test.hfe");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a test HFE file\n");
    });

    it("should unzip ROM files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-rom.zip")));
        const result = await unzipRomImage(zipData);

        expect(result.name).toBe("test.rom");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a test ROM file\n");
    });

    it("should handle ZIP with multiple files by picking the first compatible one", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-mixed.zip")));
        const result = await unzipDiscImage(zipData);

        // Should get the first compatible file (order may vary)
        expect(result.name === "test.ssd" || result.name === "test.rom").toBeTruthy();
        expect(result.data instanceof Uint8Array).toBeTruthy();
    });

    it("should name the loadable files it passed over", async () => {
        const result = await unzipDiscImage(readZip("test-two-sides.zip"));

        expect(result.name).toBe("side1.ssd");
        expect(result.ignored).toEqual(["side2.ssd"]);
    });

    it("should not count files of other kinds as passed over", async () => {
        const result = await unzipDiscImage(readZip("test-mixed.zip"));

        expect(result.name).toBe("test.ssd");
        expect(result.ignored).toEqual([]);
    });

    it("should throw error for ZIP with no compatible files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-ssd.zip")));

        await expect(unzipRomImage(zipData)).rejects.toThrow(/Couldn't find any compatible files/);
    });

    it("should handle deflate-compressed ZIP files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-deflated.zip")));
        const result = await unzipDiscImage(zipData);

        expect(result.name).toBe("test.ssd");
        expect(result.data instanceof Uint8Array).toBeTruthy();

        const content = Array.from(result.data)
            .map((b) => String.fromCharCode(b))
            .join("");
        expect(content).toBe("This is a deflate-compressed test SSD file\n");
    });

    it("should throw for unsupported compression method", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-bzip2.zip")));

        await expect(unzipDiscImage(zipData)).rejects.toThrow(/Unsupported ZIP compression method/);
    });

    it("should throw for truncated/corrupt ZIP files", async () => {
        const zipData = new Uint8Array(fs.readFileSync(join(__dirname, "zip", "test-truncated.zip")));

        await expect(unzipDiscImage(zipData)).rejects.toThrow(/Not a ZIP file/);
    });

    it("should throw for non-ZIP data", async () => {
        const notZip = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

        await expect(unzipDiscImage(notZip)).rejects.toThrow(/Not a ZIP file/);
    });

    it("should throw for a stored entry whose data does not match its CRC32", async () => {
        const zipData = corruptFirstEntry(readZip("test-ssd.zip"), 0);

        await expect(unzipDiscImage(zipData)).rejects.toThrow(/Corrupt ZIP entry test\.ssd: CRC32 mismatch/);
    });

    it("should throw for a deflated entry that inflates cleanly to the wrong bytes", async () => {
        const zipData = corruptFirstEntry(readZip("test-deflated.zip"), 5);

        await expect(unzipDiscImage(zipData)).rejects.toThrow(/Corrupt ZIP entry test\.ssd: CRC32 mismatch/);
    });

    it("should throw for a deflated entry whose stream is damaged beyond inflating", async () => {
        const zipData = corruptFirstEntry(readZip("test-deflated.zip"), 0);

        await expect(unzipDiscImage(zipData)).rejects.toThrow(/Unable to inflate ZIP entry test\.ssd/);
    });
});

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
