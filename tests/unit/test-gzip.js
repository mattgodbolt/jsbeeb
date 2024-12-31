import { describe, it } from "vitest";
import assert from "assert";
import * as fs from "fs";
import * as utils from "../../src/utils.js";

import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function testOneFile(file) {
    const compressed = new Uint8Array(fs.readFileSync(file + ".gz"));
    const expected = new Uint8Array(fs.readFileSync(file));
    assert.deepStrictEqual(utils.ungzip(compressed), expected);
}

describe("gzip tests", function () {
    for (let fileIndex = 1; ; fileIndex++) {
        let file = __dirname + "/gzip/test-" + fileIndex;
        if (!fs.existsSync(file)) break;
        it("handles test case " + file, () => testOneFile(file));
    }
});
