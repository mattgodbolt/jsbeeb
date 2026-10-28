import { describe, expect, it } from "vitest";
import * as fs from "fs";
import path from "node:path";
import { RepoRoot } from "./helpers.js";

describe("ensure git submodules are present", function () {
    it.each([
        ["functional", "tests/6502_65C02_functional_tests/README.md"],
        ["timing", "tests/integration/dp111_6502Timing/README.md"],
    ])("should have the %s tests", function (_, readme) {
        expect(
            fs.existsSync(path.join(RepoRoot, readme)),
            "Submodule missing. Ensure git submodules are fetched (git submodule update --init).",
        ).toBe(true);
    });
});
