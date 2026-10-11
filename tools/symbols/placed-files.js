/**
 * The files on a title's DFS discs, placed where they load: what the corpus check compares regions with,
 * and what an importer tells a title's regions apart from.
 */

import path from "node:path";

import { dfsCatalogue } from "../registry/dfs.js";
import { extensionOf, sectorImageSides } from "../registry/fingerprint.js";

const Page = 0x100;
const AddressLimit = 0x10000;
const IoAddressMask = 0xffff;
const DfsImages = new Set([".ssd", ".dsd"]);

/**
 * Each file worth placing from one title's zip members, once per content and load address.
 * @param {Record<string, Uint8Array>} members
 * @returns {{name: string, load: number, data: Uint8Array}[]}
 */
export function placedFiles(members) {
    const files = [];
    const seen = new Set();
    for (const member of Object.keys(members).sort()) {
        if (!DfsImages.has(extensionOf(member))) continue;
        for (const side of sectorImageSides(member, members[member])) {
            for (const file of dfsCatalogue(side)?.files ?? []) {
                if (!file.complete || file.length === 0 || file.uniform) continue;
                const load = file.load & IoAddressMask;
                if (load < Page || load + file.length > AddressLimit) continue;
                const key = `${load}:${file.hash}:${file.length}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const data = side.subarray(file.start * Page, file.start * Page + file.length);
                files.push({ name: `${path.basename(member)}:${file.name}`, load, data });
            }
        }
    }
    return files;
}
