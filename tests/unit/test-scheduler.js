const {requirejs} = require('./r');
const {describe, it} = require('mocha');
const assert = require('assert');
const Scheduler = requirejs('scheduler').Scheduler;

describe('Scheduler tests', function () {
    "use strict";
    it('creates', function (done) {
        new Scheduler();
        done();
    });

    it('handles simple cases', function (done) {
        const s = new Scheduler();
        let called = false;
        const t = s.newTask(function () {
            assert.strictEqual(called, false);
            called = true;
        });
        t.schedule(2);
        assert.strictEqual(called, false);
        s.polltime(1);
        assert.strictEqual(called, false);
        s.polltime(1);
        assert.strictEqual(called, true);
        s.polltime(1);

        done();
    });
    it('handles simple cases with a big step', function (done) {
        const s = new Scheduler();
        let called = false;
        const t = s.newTask(function () {
            assert.strictEqual(called, false);
            called = true;
        });
        t.schedule(2);
        assert.strictEqual(called, false);
        s.polltime(2);
        assert.strictEqual(called, true);
        s.polltime(2);

        done();
    });
    it('handles simple cases with a big step past', function (done) {
        const s = new Scheduler();
        let called = false;
        const t = s.newTask(function () {
            assert.strictEqual(called, false);
            called = true;
        });
        t.schedule(2);
        assert.strictEqual(called, false);
        s.polltime(3);
        assert.strictEqual(called, true);
        s.polltime(3);

        done();
    });
    it('calls callbacks in the order registered when occurring on same cycle', function (done) {
        const s = new Scheduler();
        let called = "";
        s.newTask(function () {
            called += 'a';
        }).schedule(2);
        s.newTask(function () {
            called += 'b';
        }).schedule(2);
        s.newTask(function () {
            called += 'c';
        }).schedule(2);
        assert.strictEqual(called, '');
        s.polltime(1);
        assert.strictEqual(called, '');
        s.polltime(1);
        assert.strictEqual(called, 'abc');
        s.polltime(1);

        done();
    });
    it('cancels first occurring event', function (done) {
        const s = new Scheduler();
        let called = "";
        const a = s.newTask(function () {
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
        assert.strictEqual(called, 'bc');
        done();
    });
    it('cancels middle occurring event', function (done) {
        const s = new Scheduler();
        let called = "";
        s.newTask(function () {
            called += 'a';
        }).schedule(2);
        const b = s.newTask(function () {
            called += 'b';
        });
        b.schedule(2);
        s.newTask(function () {
            called += 'c';
        }).schedule(2);
        b.cancel();
        s.polltime(2);
        assert.strictEqual(called, 'ac');
        done();
    });
    it('cancels last occurring event', function (done) {
        const s = new Scheduler();
        let called = "";
        s.newTask(function () {
            called += 'a';
        }).schedule(2);
        s.newTask(function () {
            called += 'b';
        }).schedule(2);
        const c = s.newTask(function () {
            called += 'c';
        });
        c.schedule(2);
        c.cancel();
        s.polltime(2);
        assert.strictEqual(called, 'ab');
        done();
    });
    it('handle events registered in reverse (CBA) order', function (done) {
        const s = new Scheduler();
        let called = "";
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
        assert.strictEqual(called, 'cba');

        done();
    });
    it('handle events registered in CAB order', function (done) {
        const s = new Scheduler();
        let called = "";
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
        assert.strictEqual(called, 'cab');

        done();
    });
    it('works properly with epochs', function (done) {
        const s = new Scheduler();
        s.polltime(12346);
        const epochBefore = s.epoch;
        let epochAtCall = 0;
        s.newTask(function () {
            epochAtCall = s.epoch;
        }).schedule(4);
        s.polltime(9974);
        assert.strictEqual(4, epochAtCall - epochBefore);
        done();
    });
    it('allows you to reschedule from within a callback', function (done) {
        const s = new Scheduler();
        s.polltime(12346);
        const times = [1000, 1000, 100000, 1000];
        const called = [];
        const task = s.newTask(function () {
            called.push(s.epoch);
            const next = times.shift();
            if (next) {
                task.schedule(next);
            }
        });
        task.schedule(10);
        for (let i = 0; i < 500000; ++i) {
            s.polltime(3);
        }
        assert.deepStrictEqual(called, [12356, 13356, 14356, 114356, 115356]);
        done();
    });
});

// TODO: handle time overflow - has to inform anyone with the epoch cached