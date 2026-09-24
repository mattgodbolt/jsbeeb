// Reads a DFS catalogue from a side's bytes, hashing each file it lists.

import { createHash } from "node:crypto";
import { SectorSize } from "./fingerprint.js";

const shortHash = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 32);

const printable = (bytes) => String.fromCharCode(...bytes.map((b) => b & 0x7f)).replace(/[\0 ]+$/, "");

/** Reads a DFS catalogue from a side's bytes, or null if it doesn't look like one. */
export function dfsCatalogue(side) {
    if (side.length < 2 * SectorSize) return null;
    const s0 = side.subarray(0, SectorSize);
    const s1 = side.subarray(SectorSize, 2 * SectorSize);
    const entriesBytes = s1[5];
    if (entriesBytes & 7 || entriesBytes > 31 * 8) return null;
    const totalSectors = ((s1[6] & 3) << 8) | s1[7];
    if (totalSectors < 2 || totalSectors > 800) return null;
    const files = [];
    for (let offset = 8; offset <= entriesBytes; offset += 8) {
        const nameBytes = s0.subarray(offset, offset + 7);
        if (nameBytes.some((b) => (b & 0x7f) < 0x20)) return null;
        const mixed = s1[offset + 6];
        const load = s1[offset] | (s1[offset + 1] << 8) | (((mixed >> 2) & 3) << 16);
        const exec = s1[offset + 2] | (s1[offset + 3] << 8) | (((mixed >> 6) & 3) << 16);
        const length = s1[offset + 4] | (s1[offset + 5] << 8) | (((mixed >> 4) & 3) << 16);
        const start = s1[offset + 7] | ((mixed & 3) << 8);
        if (start < 2 || start > totalSectors) return null;
        const data = side.subarray(start * SectorSize, start * SectorSize + length);
        files.push({
            name: `${String.fromCharCode(s0[offset + 7] & 0x7f)}.${printable(nameBytes)}`,
            load,
            exec,
            length,
            start,
            complete: data.length === length,
            hash: shortHash(data),
        });
    }
    return {
        title: printable([...s0.subarray(0, 8), ...s1.subarray(0, 4)]),
        cycle: s1[4],
        boot: (s1[6] >> 4) & 3,
        totalSectors,
        files,
    };
}
