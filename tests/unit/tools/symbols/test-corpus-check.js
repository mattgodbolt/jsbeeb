import { describe, expect, it } from "vitest";

import { corpusReport, placedFiles } from "../../../../tools/symbols/corpus-check.js";

const SectorSize = 256;
const TotalSectors = 400;
const HighLoadBits = 0x0c;

/** An .ssd whose catalogue lists `files`, each {name, load, data, highLoad}, from sector 2 on. */
function ssd(files) {
    const image = new Uint8Array(TotalSectors * SectorSize);
    let sector = 2;
    files.forEach(({ name, load, data, highLoad = false }, i) => {
        const offset = 8 * (i + 1);
        [...name.padEnd(7)].forEach((c, j) => (image[offset + j] = c.charCodeAt(0)));
        image[offset + 7] = "$".charCodeAt(0);
        const entry = SectorSize + offset;
        image[entry] = load & 0xff;
        image[entry + 1] = (load >> 8) & 0xff;
        image[entry + 4] = data.length & 0xff;
        image[entry + 5] = data.length >> 8;
        image[entry + 6] = (highLoad ? HighLoadBits : 0) | (sector >> 8);
        image[entry + 7] = sector & 0xff;
        image.set(data, sector * SectorSize);
        sector += Math.ceil(data.length / SectorSize);
    });
    image[SectorSize + 5] = 8 * files.length;
    image[SectorSize + 6] = TotalSectors >> 8;
    image[SectorSize + 7] = TotalSectors & 0xff;
    return image;
}

const program = Uint8Array.from({ length: 0x40 }, (_, i) => (i * 7 + 3) & 0xff);

describe("placedFiles", () => {
    it("places each complete file at its load address in the I/O processor, once per content and address", () => {
        const disc = ssd([
            { name: "GAME", load: 0x1900, data: program, highLoad: true },
            { name: "BLANK", load: 0x3000, data: new Uint8Array(0x20) },
            { name: "ZP", load: 0x0070, data: program.subarray(0, 4) },
        ]);
        const files = placedFiles({ "a.ssd": disc, "b.ssd": disc, "notes.txt": new Uint8Array(4) });
        expect(files.map(({ name, load }) => [name, load])).toEqual([["a.ssd:$.GAME", 0x1900]]);
        expect([...files[0].data]).toEqual([...program]);
    });
});

describe("corpusReport", () => {
    const region = {
        name: "main",
        start: 0x1900,
        end: 0x1940,
        anchors: [{ at: 0x1904, data: [...program.subarray(4, 10)] }],
        memory: new Map([...program].map((byte, i) => [0x1900 + i, byte])),
    };
    const sets = [{ id: "demo", regions: [region] }];

    it("calls a title holding the anchors and the region's bytes the same code", () => {
        const titles = new Map([["Pub/Crack.zip", [{ name: "c.ssd:$.GAME", load: 0x1900, data: program }]]]);
        const { report, collisions } = corpusReport(sets, titles);
        expect(collisions).toBe(0);
        expect(report).toContain(
            "| main &1900-&193F | 1 | 1 | Pub/Crack.zip | c.ssd:$.GAME | 64 of 64 | 64 (100.0%) |",
        );
    });

    it("calls a title holding the anchors over different bytes a collision", () => {
        const other = program.map((byte, i) => (i >= 4 && i < 10 ? byte : byte ^ 0xff));
        const titles = new Map([["Pub/Other.zip", [{ name: "o.ssd:$.OTHER", load: 0x1900, data: other }]]]);
        const { report, collisions } = corpusReport(sets, titles);
        expect(collisions).toBe(1);
        expect(report).toContain("64 of 64 | 6 (9.4%) (collision) |");
    });

    it("says none when no title holds every anchor", () => {
        const { report, collisions } = corpusReport(sets, new Map());
        expect(collisions).toBe(0);
        expect(report).toContain("| main &1900-&193F | 1 | 0 | none | | | |");
    });
});
