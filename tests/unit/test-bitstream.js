import { describe, it } from "mocha";
import assert from "assert";

import { BitStream } from "../../bitstream.js";

describe("BitStream tests", function () {
    "use strict";

    it("starts out at the beginning", function (done) {
        const bs = new BitStream([0]);
        assert.strictEqual(bs.position(), 0);
        done();
    });
    it("shifts out bits in the right order", function (done) {
        const bs = new BitStream([0x01]);
        assert.strictEqual(bs.nextBit(), true);
        assert.strictEqual(bs.nextBit(), false);
        done();
    });
    it("reads multiple bits", function (done) {
        const bs = new BitStream([0x01]);
        assert.strictEqual(bs.nextBits(2), 0x02);
        done();
    });
    it("repeats", function (done) {
        const bs = new BitStream([0x01], 2);
        bs.nextBit();
        assert.strictEqual(bs.position(), 1);
        bs.nextBit();
        assert.strictEqual(bs.position(), 0);
        assert.strictEqual(bs.nextBit(), true);
        done();
    });
    it("repeats even across multiple bits", function (done) {
        const bs = new BitStream([0x01], 2);
        assert.strictEqual(0xaaaa, bs.nextBits(16));
        done();
    });
    it("peeks", function (done) {
        const bs = new BitStream([0xf1]);
        assert.strictEqual(0x8, bs.peekBits(4));
        assert.strictEqual(bs.position(), 0);
        assert.strictEqual(0x8, bs.peekBits(4));
        done();
    });
    it("handles multi-byte data", function (done) {
        const bs = new BitStream([0x01, 0xff, 0x80]);
        assert.strictEqual(bs.nextBit(), true);
        for (let i = 0; i < 7; ++i) assert.strictEqual(bs.nextBit(), false);
        for (let i = 0; i < 8; ++i) assert.strictEqual(bs.nextBit(), true);
        for (let i = 0; i < 7; ++i) assert.strictEqual(bs.nextBit(), false);
        assert.strictEqual(bs.nextBit(), true);
        done();
    });
    it("handles no data", function (done) {
        const bs = new BitStream([]);
        assert.strictEqual(bs.position(), 0);
        assert.strictEqual(bs.nextBit(), false);
        assert.strictEqual(bs.position(), 0);
        done();
    });
    it("decodes bitstreams that look like HFE discs", function (done) {
        const bs = new BitStream([0x8f, 0x4f, 0x12, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
        assert.strictEqual(bs.nextBits(4), 0xf); // it's a command
        assert.strictEqual(bs.nextBits(4), 0x1); // it's the set index!
        assert.strictEqual(bs.nextBits(4), 0xf); // it's another command
        assert.strictEqual(bs.nextBits(4), 0x2); // it's a set speed
        assert.strictEqual(bs.nextBits(8), 72); // 72 bit rate-ons
        assert.strictEqual(bs.nextBits(8), 0x55); // it's some edges...
        done();
    });
});
