var requirejs = require('requirejs');
var Scheduler = requirejs('scheduler').Scheduler;

exports.testCreate = function (test) {
    var s = new Scheduler();
    test.done();
};

exports.testSimpleCase = function (test) {
    var s = new Scheduler();
    var called = false;
    var t = s.newTask(function () {
        test.equals(called, false);
        called = true;
    });
    t.schedule(2);
    test.equals(called, false);
    s.polltime(1);
    test.equals(called, false);
    s.polltime(1);
    test.equals(called, true);
    s.polltime(1);

    test.done();
};

exports.testSimpleCaseBigStep = function (test) {
    var s = new Scheduler();
    var called = false;
    var t = s.newTask(function () {
        test.equals(called, false);
        called = true;
    });
    t.schedule(2);
    test.equals(called, false);
    s.polltime(2);
    test.equals(called, true);
    s.polltime(2);

    test.done();
};

exports.testSimpleCaseBigStepPast = function (test) {
    var s = new Scheduler();
    var called = false;
    var t = s.newTask(function () {
        test.equals(called, false);
        called = true;
    });
    t.schedule(2);
    test.equals(called, false);
    s.polltime(3);
    test.equals(called, true);
    s.polltime(3);

    test.done();
};

exports.testMultiSameTimeCalledInOrder = function (test) {
    var s = new Scheduler();
    var called = "";
    s.newTask(function () {
        called += 'a';
    }).schedule(2);
    s.newTask(function () {
        called += 'b';
    }).schedule(2);
    s.newTask(function () {
        called += 'c';
    }).schedule(2);
    test.equals(called, '');
    s.polltime(1);
    test.equals(called, '');
    s.polltime(1);
    test.equals(called, 'abc');
    s.polltime(1);

    test.done();
};

exports.testCancelFirst = function (test) {
    var s = new Scheduler();
    var called = "";
    var a = s.newTask(function () {
        called += 'a';
    });
    a.schedule(2);
    s.newTask(function () {
        called += 'b';
    }).schedule(2);
    s.newTask(function () {
        called += 'c';
    }).schedule(2);
    a.cancel();
    s.polltime(2);
    test.equals(called, 'bc');
    test.done();
};

exports.testCancelMiddle = function (test) {
    var s = new Scheduler();
    var called = "";
    s.newTask(function () {
        called += 'a';
    }).schedule(2);
    var b = s.newTask(function () {
        called += 'b';
    });
    b.schedule(2);
    s.newTask(function () {
        called += 'c';
    }).schedule(2);
    b.cancel();
    s.polltime(2);
    test.equals(called, 'ac');
    test.done();
};

exports.testCancelEnd = function (test) {
    var s = new Scheduler();
    var called = "";
    s.newTask(function () {
        called += 'a';
    }).schedule(2);
    s.newTask(function () {
        called += 'b';
    }).schedule(2);
    var c = s.newTask(function () {
        called += 'c';
    });
    c.schedule(2);
    c.cancel();
    s.polltime(2);
    test.equals(called, 'ab');
    test.done();
};

exports.testSortOrderReverse = function (test) {
    var s = new Scheduler();
    var called = "";
    s.newTask(function () {
        called += 'a';
    }).schedule(4);
    s.newTask(function () {
        called += 'b';
    }).schedule(3);
    s.newTask(function () {
        called += 'c';
    }).schedule(2);
    s.polltime(10);
    test.equals(called, 'cba');

    test.done();
};

exports.testSortOrderCab = function (test) {
    var s = new Scheduler();
    var called = "";
    s.newTask(function () {
        called += 'a';
    }).schedule(3);
    s.newTask(function () {
        called += 'b';
    }).schedule(4);
    s.newTask(function () {
        called += 'c';
    }).schedule(2);
    s.polltime(10);
    test.equals(called, 'cab');

    test.done();
};

// TODO: handle time overflow