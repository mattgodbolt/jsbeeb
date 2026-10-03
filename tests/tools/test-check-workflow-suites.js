import { describe, expect, it } from "vitest";

import { suitesMissingFrom } from "../../tools/check-workflow-suites.js";

describe("suitesMissingFrom", () => {
    const scripts = {
        "test:unit": "vitest run tests/unit",
        "test:cpu": "node tests/test-suite.js",
        lint: "eslint .",
    };

    it("is satisfied when every suite is run somewhere in the workflow", () => {
        const workflow = "run: npm run test:unit -- --coverage\nrun: npm run test:cpu\n";
        expect(suitesMissingFrom(scripts, workflow)).toEqual([]);
    });

    it("names each suite the workflow never runs", () => {
        expect(suitesMissingFrom(scripts, "run: npm run test:unit\n")).toEqual(["test:cpu"]);
    });

    it("ignores scripts that are not test suites", () => {
        expect(suitesMissingFrom({ lint: "eslint ." }, "")).toEqual([]);
    });
});
