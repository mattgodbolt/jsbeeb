import { describe, it } from "mocha";
import assert from "assert";

import { Fifo } from "../../utils.js";

describe("FIFO tests", function () {
    "use strict";
    it("creates ok", function (done) {
        new Fifo(16);
        done();
    });
    it("works for simple cases", function (done) {
        const f = new Fifo(16);
        assert.strictEqual(0, f.size);
        f.put(123);
        assert.strictEqual(1, f.size);
        assert.strictEqual(123, f.get());
        assert.strictEqual(0, f.size);
        done();
    });

    it("works when full", function (done) {
        const f = new Fifo(4);
        assert.strictEqual(0, f.size);
        f.put(123);
        f.put(125);
        f.put(126);
        f.put(127);
        assert.strictEqual(4, f.size);
        f.put(100);
        assert.strictEqual(4, f.size);
        assert.strictEqual(123, f.get());
        assert.strictEqual(125, f.get());
        assert.strictEqual(126, f.get());
        assert.strictEqual(127, f.get());
        assert.strictEqual(0, f.size);
        done();
    });
});
