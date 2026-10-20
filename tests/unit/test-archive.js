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
        const data = new TextEncoder().encode("123456789");
        expect((crc32(data) >>> 0).toString(16)).toBe("cbf43926");
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
    it.each([
        ["SSD", "test-ssd.zip", unzipDiscImage, "test.ssd", "This is a test SSD file\n"],
        ["ADFS", "test-adf.zip", unzipDiscImage, "test.adf", "This is a test ADF file\n"],
        ["HFE", "test-hfe.zip", unzipDiscImage, "test.hfe", "This is a test HFE file\n"],
        ["ROM", "test-rom.zip", unzipRomImage, "test.rom", "This is a test ROM file\n"],
        [
            "deflate-compressed SSD",
            "test-deflated.zip",
            unzipDiscImage,
            "test.ssd",
            "This is a deflate-compressed test SSD file\n",
        ],
    ])("should unzip %s files", async (_, zip, unzipImage, name, text) => {
        const result = await unzipImage(readZip(zip));

        expect(result.name).toBe(name);
        expect(result.data).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(result.data)).toBe(text);
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

    it.each([
        [
            "a ZIP with no compatible files",
            unzipRomImage,
            () => readZip("test-ssd.zip"),
            /Couldn't find any compatible files/,
        ],
        [
            "an unsupported compression method",
            unzipDiscImage,
            () => readZip("test-bzip2.zip"),
            /Unsupported ZIP compression method/,
        ],
        ["a truncated ZIP file", unzipDiscImage, () => readZip("test-truncated.zip"), /Not a ZIP file/],
        ["non-ZIP data", unzipDiscImage, () => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), /Not a ZIP file/],
        [
            "a stored entry whose data does not match its CRC32",
            unzipDiscImage,
            () => corruptFirstEntry(readZip("test-ssd.zip"), 0),
            /Corrupt ZIP entry test\.ssd: CRC32 mismatch/,
        ],
        [
            "a deflated entry that inflates cleanly to the wrong bytes",
            unzipDiscImage,
            () => corruptFirstEntry(readZip("test-deflated.zip"), 5),
            /Corrupt ZIP entry test\.ssd: CRC32 mismatch/,
        ],
        [
            "a deflated entry whose stream is damaged beyond inflating",
            unzipDiscImage,
            () => corruptFirstEntry(readZip("test-deflated.zip"), 0),
            /Unable to inflate ZIP entry test\.ssd/,
        ],
    ])("should throw for %s", async (_, unzipImage, zipData, error) => {
        await expect(unzipImage(zipData())).rejects.toThrow(error);
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
