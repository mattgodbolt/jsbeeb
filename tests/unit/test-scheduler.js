const {requirejs} = require('./r');
const assert = require('assert');
var Scheduler = requirejs('scheduler').Scheduler;

describe('Scheduler tests', function () {
    it('creates', function (done) {
        var s = new Scheduler();
        done();
    });

    it('handles simple cases', function (done) {
        var s = new Scheduler();
        var called = false;
        var t = s.newTask(function () {
            assert.equal(called, false);
            called = true;
        });
        t.schedule(2);
        assert.equal(called, false);
        s.polltime(1);
        assert.equal(called, false);
        s.polltime(1);
        assert.equal(called, true);
        s.polltime(1);

        done();
    });
    it('handles simple cases with a big step', function (done) {
        var s = new Scheduler();
        var called = false;
        var t = s.newTask(function () {
            assert.equal(called, false);
            called = true;
        });
        t.schedule(2);
        assert.equal(called, false);
        s.polltime(2);
        assert.equal(called, true);
        s.polltime(2);

        done();
    });
    it('handles simple cases with a big step past', function (done) {
        var s = new Scheduler();
        var called = false;
        var t = s.newTask(function () {
            assert.equal(called, false);
            called = true;
        });
        t.schedule(2);
        assert.equal(called, false);
        s.polltime(3);
        assert.equal(called, true);
        s.polltime(3);

        done();
    });
    it('calls callbacks in the order registered when occuring on same cycle', function (done) {
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
        assert.equal(called, '');
        s.polltime(1);
        assert.equal(called, '');
        s.polltime(1);
        assert.equal(called, 'abc');
        s.polltime(1);

        done();
    });
    it('cancels first occurring event', function (done) {
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
        assert.equal(called, 'bc');
        done();
    });
    it('cancels middle occurring event', function (done) {
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
        assert.equal(called, 'ac');
        done();
    });
    it('cancels last occurring event', function (done) {
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
        assert.equal(called, 'ab');
        done();
    });
    it('handle events registered in reverse (CBA) order', function (done) {
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
        assert.equal(called, 'cba');

        done();
    });
    it('handle events registered in CAB order', function (done) {
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
        assert.equal(called, 'cab');

        done();
    });
    it('works properly with epochs', function (done) {
        var s = new Scheduler();
        s.polltime(12346);
        var epochBefore = s.epoch;
        var epochAtCall = 0;
        s.newTask(function () {
            epochAtCall = s.epoch;
        }).schedule(4);
        s.polltime(9974);
        assert.equal(4, epochAtCall - epochBefore);
        done();
    });
    it('allows you to reschedule from within a callback', function (done) {
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
        assert.deepEqual(called, [12356, 13356, 14356, 114356, 115356]);
        done();
    });
});

// TODO: handle time overflow - has to inform anyone with the epoch cached