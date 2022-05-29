import { describe, it } from "mocha";
import assert from "assert";

import { fake65C12 } from "../../fake6502.js";

const cpu = fake65C12();

describe("BCD tests", function () {
    "use strict";
    it("handles 65c12sbc1", function () {
        return cpu.initialise().then(function () {
            cpu.p.reset();
            cpu.p.d = true;
            cpu.a = 0x90;
            cpu.sbc(0x0b);
            assert.strictEqual(cpu.p.v, false, "Expected V clear");
            assert.strictEqual(cpu.p.c, true, "Expected C set");
            assert.strictEqual(cpu.a, 126);
        });
    });

    it("handles 65c12sbc2", function () {
        return cpu.initialise().then(function () {
            cpu.p.reset();
            cpu.p.d = true;
            cpu.a = 0x80;
            cpu.sbc(0x01);
            assert.strictEqual(cpu.p.v, true, "Expected V set");
            assert.strictEqual(cpu.p.c, true, "Expected C set");
            assert.strictEqual(cpu.a, 120);
        });
    });
});
