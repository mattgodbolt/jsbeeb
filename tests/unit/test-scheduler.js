import { describe, it } from "vitest";
import assert from "assert";
import { Scheduler } from "../../scheduler.js";

describe("Scheduler tests", function () {
    "use strict";
    it("creates", function () {
        new Scheduler();
    });

    it("handles simple cases", function () {
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
    });

    it("handles simple cases with a big step", function () {
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
    });

    it("handles simple cases with a big step past", function () {
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
    });

    it("calls callbacks in the order registered when occurring on same cycle", function () {
        const s = new Scheduler();
        let called = "";
        s.newTask(function () {
            called += "a";
        }).schedule(2);
        s.newTask(function () {
            called += "b";
        }).schedule(2);
        s.newTask(function () {
            called += "c";
        }).schedule(2);
        assert.strictEqual(called, "");
        s.polltime(1);
        assert.strictEqual(called, "");
        s.polltime(1);
        assert.strictEqual(called, "abc");
        s.polltime(1);
    });

    it("cancels first occurring event", function () {
        const s = new Scheduler();
        let called = "";
        const a = s.newTask(function () {
            called += "a";
        });
        a.schedule(2);
        s.newTask(function () {
            called += "b";
        }).schedule(2);
        s.newTask(function () {
            called += "c";
        }).schedule(2);
        a.cancel();
        s.polltime(2);
        assert.strictEqual(called, "bc");
    });

    it("cancels middle occurring event", function () {
        const s = new Scheduler();
        let called = "";
        s.newTask(function () {
            called += "a";
        }).schedule(2);
        const b = s.newTask(function () {
            called += "b";
        });
        b.schedule(2);
        s.newTask(function () {
            called += "c";
        }).schedule(2);
        b.cancel();
        s.polltime(2);
        assert.strictEqual(called, "ac");
    });

    it("cancels last occurring event", function () {
        const s = new Scheduler();
        let called = "";
        s.newTask(function () {
            called += "a";
        }).schedule(2);
        s.newTask(function () {
            called += "b";
        }).schedule(2);
        const c = s.newTask(function () {
            called += "c";
        });
        c.schedule(2);
        c.cancel();
        s.polltime(2);
        assert.strictEqual(called, "ab");
    });

    it("handle events registered in reverse (CBA) order", function () {
        const s = new Scheduler();
        let called = "";
        s.newTask(function () {
            called += "a";
        }).schedule(4);
        s.newTask(function () {
            called += "b";
        }).schedule(3);
        s.newTask(function () {
            called += "c";
        }).schedule(2);
        s.polltime(10);
        assert.strictEqual(called, "cba");
    });

    it("handle events registered in CAB order", function () {
        const s = new Scheduler();
        let called = "";
        s.newTask(function () {
            called += "a";
        }).schedule(3);
        s.newTask(function () {
            called += "b";
        }).schedule(4);
        s.newTask(function () {
            called += "c";
        }).schedule(2);
        s.polltime(10);
        assert.strictEqual(called, "cab");
    });

    it("works properly with epochs", function () {
        const s = new Scheduler();
        s.polltime(12346);
        const epochBefore = s.epoch;
        let epochAtCall = 0;
        s.newTask(function () {
            epochAtCall = s.epoch;
        }).schedule(4);
        s.polltime(9974);
        assert.strictEqual(4, epochAtCall - epochBefore);
    });

    it("allows you to reschedule from within a callback", function () {
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
    });
});
