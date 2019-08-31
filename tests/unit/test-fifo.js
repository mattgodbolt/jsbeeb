const {requirejs} = require('./r');
const assert = require('assert');

var Fifo = requirejs('utils').Fifo;

describe('FIFO tests', function () {
    it('creates ok', function (done) {
        var f = new Fifo(16);
        done();
    });
    it('works for simple cases', function (done) {
        var f = new Fifo(16);
        assert.equal(0, f.size);
        f.put(123);
        assert.equal(1, f.size);
        assert.equal(123, f.get());
        assert.equal(0, f.size);
        done();
    });

    it('works when full', function (done) {
        var f = new Fifo(4);
        assert.equal(0, f.size);
        f.put(123);
        f.put(125);
        f.put(126);
        f.put(127);
        assert.equal(4, f.size);
        f.put(100);
        assert.equal(4, f.size);
        assert.equal(123, f.get());
        assert.equal(125, f.get());
        assert.equal(126, f.get());
        assert.equal(127, f.get());
        assert.equal(0, f.size);
        done();
    });
});
