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
        test.equal(called, false);
        called = true;
    });
    t.schedule(2);
    test.equal(called, false);
    s.polltime(1);
    test.equal(called, false);
    s.polltime(1);
    test.equal(called, true);
    s.polltime(1);

    test.done();
};

exports.testSimpleCaseBigStep = function (test) {
    var s = new Scheduler();
    var called = false;
    var t = s.newTask(function () {
        test.equal(called, false);
        called = true;
    });
    t.schedule(2);
    test.equal(called, false);
    s.polltime(2);
    test.equal(called, true);
    s.polltime(2);

    test.done();
};

exports.testSimpleCaseBigStepPast = function (test) {
    var s = new Scheduler();
    var called = false;
    var t = s.newTask(function () {
        test.equal(called, false);
        called = true;
    });
    t.schedule(2);
    test.equal(called, false);
    s.polltime(3);
    test.equal(called, true);
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
    test.equal(called, '');
    s.polltime(1);
    test.equal(called, '');
    s.polltime(1);
    test.equal(called, 'abc');
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
    test.equal(called, 'bc');
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
    test.equal(called, 'ac');
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
    test.equal(called, 'ab');
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
    test.equal(called, 'cba');

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
    test.equal(called, 'cab');

    test.done();
};

exports.testEpochWorksProperly = function (test) {
    var s = new Scheduler();
    s.polltime(12346);
    var epochBefore = s.epoch;
    var epochAtCall = 0;
    s.newTask(function () {
        epochAtCall = s.epoch;
    }).schedule(4);
    s.polltime(9974);
    test.equal(4, epochAtCall - epochBefore);
    test.done();
};

exports.testCanRescheduleFromCallback = function (test) {
    var s = new Scheduler();
    s.polltime(12346);
    var times = [1000, 1000, 100000, 1000];
    var called = [];
    var task = s.newTask(function () {
        called.push(s.epoch);
        var next = times.shift();
        if (next) {
            task.schedule(next);
        }
    });
    task.schedule(10);
    for (var i = 0; i < 500000; ++i) {
        s.polltime(3);
    }
    console.log(called);
    test.deepEqual(called, [12356, 13356, 14356, 114356, 115356]);
    test.done();
};

// TODO: handle time overflow - has to inform anyone with the epoch cached