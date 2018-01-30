var requirejs = require('requirejs');
var Fifo = requirejs('utils').Fifo;

exports.testCreate = function (test) {
    var f = new Fifo(16);
    test.done();
};

exports.testSimpleCase = function (test) {
    var f = new Fifo(16);
    test.equal(0, f.size);
    f.put(123);
    test.equal(1, f.size);
    test.equal(123, f.get());
    test.equal(0, f.size);
    test.done();
}
exports.testFull = function (test) {
    var f = new Fifo(4);
    test.equal(0, f.size);
    f.put(123);
    f.put(125);
    f.put(126);
    f.put(127);
    test.equal(4, f.size);
    f.put(100);
    test.equal(4, f.size);
    test.equal(123, f.get());
    test.equal(125, f.get());
    test.equal(126, f.get());
    test.equal(127, f.get());
    test.equal(0, f.size);
    test.done();
}
