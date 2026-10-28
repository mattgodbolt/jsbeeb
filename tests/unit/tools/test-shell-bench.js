import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundleSide, findShell } from "../../../tools/shell-bench.js";

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let scratch;
beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "jsbeeb-shell-bench-test-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("findShell", () => {
    it("takes a named binary as it is, if it is there", () => {
        const js = path.join(scratch, "js");
        writeFileSync(js, "");
        expect(findShell("spidermonkey", js)).toEqual({ binary: js, description: `spidermonkey (${js})` });
        expect(() => findShell("spidermonkey", path.join(scratch, "nojs"))).toThrow("No shell at");
    });

    it("finds jsvu's install and the version jsvu recorded", () => {
        mkdirSync(path.join(scratch, "bin"));
        writeFileSync(path.join(scratch, "bin", "v8"), "");
        writeFileSync(path.join(scratch, "status.json"), JSON.stringify({ v8: "15.8.30" }));
        expect(findShell("v8", undefined, scratch)).toEqual({
            binary: path.join(scratch, "bin", "v8"),
            description: "v8 15.8.30",
        });
    });

    it("says when jsvu has not installed the engine", () => {
        expect(() => findShell("v8", undefined, scratch)).toThrow("install it with npx jsvu --engines=v8");
    });
});

describe("bundleSide", () => {
    it("gives each bundled module its own path in the side's checkout as import.meta.url", async () => {
        const bundle = path.join(scratch, "bundle.js");
        await bundleSide(RepoRoot, bundle);
        const testMachineUrl = pathToFileURL(path.join(RepoRoot, "src", "test-machine.js")).href;
        expect(readFileSync(bundle, "utf8")).toContain(JSON.stringify(testMachineUrl));
    });
});
