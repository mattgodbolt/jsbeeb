import { describe, expect, it } from "vitest";

import { Filestore } from "../../src/filestore.js";

describe("Filestore", () => {
    it("finds its code and its disc where the page fetches them", async () => {
        const filestore = new Filestore({}, {});
        await filestore.reset();
        expect(filestore.l3fs.length).toBeGreaterThan(0);
        expect(filestore.ram.subarray(0x400, 0x400 + filestore.l3fs.length)).toEqual(new Uint8Array(filestore.l3fs));
        expect(filestore.PC).toBe(0x400);
        expect(filestore.scsi.length).toBeGreaterThan(0);
    });
});
