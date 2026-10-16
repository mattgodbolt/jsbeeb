import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// What a headless machine loads from public/ when a MachineSession option asks for it.
const HeadlessData = [
    "public/econet/L3FS.dat",
    "public/econet/scsi.dat",
    ...[0, 1, 2, 3].map((channel) => `public/teletext/txt${channel}.dat`),
];

function packedFiles() {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
    return JSON.parse(output)[0].files.map(({ path }) => path);
}

describe("the npm package", () => {
    it("carries the data Econet and the teletext adaptor load", () => {
        expect(packedFiles()).toEqual(expect.arrayContaining(HeadlessData));
    });
});
