import { describe, it } from "vitest";
import assert from "assert";
import * as fs from "fs";

describe("ensure git submodules are present", function () {
    it("should have functional tests", function () {
        try {
            fs.accessSync("tests/6502_65C02_functional_tests/README.md");
        } catch {
            assert.fail(
                "Functional tests submodule missing. Ensure git submodules are fetched (git submodule update --init).",
            );
        }
    });

    it("should have timing tests", function () {
        try {
            fs.accessSync("tests/integration/dp111_6502Timing/README.md");
        } catch {
            assert.fail(
                "Timing tests submodule missing. Ensure git submodules are fetched  (git submodule update --init).",
            );
        }
    });
});
