import { describe, it, expect } from "vitest";
import { Scheduler } from "../../src/scheduler.js";

describe("Scheduler tests", function () {
    "use strict";
    it("creates", function () {
        new Scheduler();
    });

    it("handles simple cases", function () {
        const s = new Scheduler();
        let called = false;
        const t = s.newTask(function () {
            expect(called).toBe(false);
            called = true;
        });
        t.schedule(2);
        expect(called).toBe(false);
        s.polltime(1);
        expect(called).toBe(false);
        s.polltime(1);
        expect(called).toBe(true);
        s.polltime(1);
    });

    it("handles simple cases with a big step", function () {
        const s = new Scheduler();
        let called = false;
        const t = s.newTask(function () {
            expect(called).toBe(false);
            called = true;
        });
        t.schedule(2);
        expect(called).toBe(false);
        s.polltime(2);
        expect(called).toBe(true);
        s.polltime(2);
    });

    it("handles simple cases with a big step past", function () {
        const s = new Scheduler();
        let called = false;
        const t = s.newTask(function () {
            expect(called).toBe(false);
            called = true;
        });
        t.schedule(2);
        expect(called).toBe(false);
        s.polltime(3);
        expect(called).toBe(true);
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
        expect(called).toBe("");
        s.polltime(1);
        expect(called).toBe("");
        s.polltime(1);
        expect(called).toBe("abc");
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
        expect(called).toBe("bc");
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
        expect(called).toBe("ac");
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
        expect(called).toBe("ab");
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
        expect(called).toBe("cba");
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
        expect(called).toBe("cab");
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
        expect(epochAtCall - epochBefore).toBe(4);
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
        expect(called).toEqual([12356, 13356, 14356, 114356, 115356]);
    });
});
