import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RepoRoot = fileURLToPath(new URL("../..", import.meta.url));
const PeripheralDataFolders = ["public/econet", "public/teletext"];

function filesUnder(folder) {
    return readdirSync(path.join(RepoRoot, folder), { recursive: true })
        .map((name) => path.posix.join(folder, name.split(path.sep).join("/")))
        .filter((file) => statSync(path.join(RepoRoot, file)).isFile());
}

function packedFiles() {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: RepoRoot,
        encoding: "utf8",
    });
    return JSON.parse(output)[0].files.map(({ path }) => path);
}

describe("the npm package", () => {
    it("carries the Econet file server and the teletext pages", () => {
        expect(packedFiles()).toEqual(expect.arrayContaining(PeripheralDataFolders.flatMap(filesUnder)));
    });
});
