import { describe, it } from "vitest";
import assert from "assert";
import * as fs from "fs";
import path from "node:path";
import { RepoRoot } from "./helpers.js";

describe("ensure git submodules are present", function () {
    it("should have functional tests", function () {
        try {
            fs.accessSync(path.join(RepoRoot, "tests/6502_65C02_functional_tests/README.md"));
        } catch {
            assert.fail(
                "Functional tests submodule missing. Ensure git submodules are fetched (git submodule update --init).",
            );
        }
    });

    it("should have timing tests", function () {
        try {
            fs.accessSync(path.join(RepoRoot, "tests/integration/dp111_6502Timing/README.md"));
        } catch {
            assert.fail(
                "Timing tests submodule missing. Ensure git submodules are fetched  (git submodule update --init).",
            );
        }
    });
});
