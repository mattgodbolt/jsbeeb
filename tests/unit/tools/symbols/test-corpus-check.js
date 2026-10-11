import { describe, expect, it } from "vitest";

import { corpusReport } from "../../../../tools/symbols/corpus-check.js";

const program = Uint8Array.from({ length: 0x40 }, (_, i) => (i * 7 + 3) & 0xff);

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

    it("counts two files of one title by what they hold, even with the same name", () => {
        const split = {
            ...region,
            anchors: [...region.anchors, { at: 0x1924, data: [...program.subarray(0x24, 0x2a)] }],
        };
        const halves = [
            { name: "c.dsd:$.GAME", load: 0x1900, data: program.subarray(0, 0x20) },
            { name: "c.dsd:$.GAME", load: 0x1920, data: program.subarray(0x20) },
        ];
        const { report } = corpusReport([{ id: "demo", regions: [split] }], new Map([["Pub/Sides.zip", halves]]));
        expect(report).toContain("| Pub/Sides.zip | c.dsd:$.GAME | 64 of 64 | 64 (100.0%) |");
    });

    it("says none when no title holds every anchor", () => {
        const { report, collisions } = corpusReport(sets, new Map());
        expect(collisions).toBe(0);
        expect(report).toContain("| main &1900-&193F | 1 | 0 | none | | | |");
    });
});
