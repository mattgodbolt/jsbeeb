var requirejs = require('./r').requirejs;
var assert = require('assert');

var Fake6502 = requirejs('fake6502');
var cpu = Fake6502.fake65C12();

describe('BCD tests', function () {
    it('handles 65c12sbc1', function () {
        return cpu.initialise().then(function () {
            cpu.p.reset();
            cpu.p.d = true;
            cpu.a = 0x90;
            cpu.sbc(0x0b);
            assert.equal(cpu.p.v, false, "Expected V clear");
            assert.equal(cpu.p.c, true, "Expected C set");
            assert.equal(cpu.a, 126);
        });
    });

    it('handles 65c12sbc2', function () {
        return cpu.initialise().then(function () {
            cpu.p.reset();
            cpu.p.d = true;
            cpu.a = 0x80;
            cpu.sbc(0x01);
            assert.equal(cpu.p.v, true, "Expected V set");
            assert.equal(cpu.p.c, true, "Expected C set");
            assert.equal(cpu.a, 120);
        });
    });
});
