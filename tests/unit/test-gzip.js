import { describe, it } from "mocha";
import assert from "assert";
import * as fs from "fs";
import * as utils from "../../utils.js";

import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function testOneFile(file) {
    "use strict";
    return (done) => {
        const compressed = new Uint8Array(fs.readFileSync(file + ".gz"));
        const expected = new Uint8Array(fs.readFileSync(file));
        assert.deepStrictEqual(utils.ungzip(compressed), expected);
        done();
    };
}

describe("gzip tests", function () {
    "use strict";
    for (let fileIndex = 1; ; fileIndex++) {
        let file = __dirname + "/gzip/test-" + fileIndex;
        if (!fs.existsSync(file)) break;
        it("handles test case " + file, testOneFile(file));
    }
});
