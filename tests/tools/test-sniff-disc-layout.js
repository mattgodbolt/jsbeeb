import { brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { decompressedIfBrotli } from "../../tools/sniff-disc-layout.js";

const hfe = (magic = "HXCHFEV3") => {
    const image = new Uint8Array(64);
    image.set([...magic].map((c) => c.charCodeAt(0)));
    image[8] = 0x01;
    return image;
};

describe("decompressedIfBrotli", () => {
    it("undoes the compression a mirror stores its blobs with", () => {
        const image = hfe();
        expect(decompressedIfBrotli(new Uint8Array(brotliCompressSync(image)))).toEqual(image);
    });

    it("leaves an image that is already an image alone", () => {
        const image = hfe();
        expect(decompressedIfBrotli(image)).toBe(image);
    });

    it("knows the older HFE magic too", () => {
        const image = hfe("HXCPICFE");
        expect(decompressedIfBrotli(image)).toBe(image);
    });

    // Whatever it is, the loader gives a better account of it than a decompressor would.
    it("hands back something that is neither, for the loader to complain about", () => {
        const rubbish = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(decompressedIfBrotli(rubbish)).toBe(rubbish);
    });
});
