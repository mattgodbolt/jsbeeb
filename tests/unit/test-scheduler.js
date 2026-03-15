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

    describe("cancelAll", () => {
        it("should cancel all scheduled tasks", () => {
            const s = new Scheduler();
            const t1 = s.newTask(() => {});
            const t2 = s.newTask(() => {});
            const t3 = s.newTask(() => {});
            t1.schedule(10);
            t2.schedule(20);
            t3.schedule(30);
            expect(s.headroom()).toBe(10);

            s.cancelAll();
            expect(s.headroom()).toBe(Scheduler.MaxHeadroom);
            expect(t1.scheduled()).toBe(false);
            expect(t2.scheduled()).toBe(false);
            expect(t3.scheduled()).toBe(false);
        });

        it("should handle empty scheduler", () => {
            const s = new Scheduler();
            s.cancelAll();
            expect(s.headroom()).toBe(Scheduler.MaxHeadroom);
        });
    });

    describe("snapshotState / restoreState", () => {
        it("should snapshot and restore epoch", () => {
            const s = new Scheduler();
            s.polltime(12345);
            const snapshot = s.snapshotState();
            expect(snapshot.epoch).toBe(12345);

            const s2 = new Scheduler();
            s2.restoreState(snapshot);
            expect(s2.epoch).toBe(12345);
        });

        it("should cancel existing tasks on restore", () => {
            const s = new Scheduler();
            const t = s.newTask(() => {});
            t.schedule(100);
            expect(t.scheduled()).toBe(true);

            s.restoreState({ epoch: 5000 });
            expect(t.scheduled()).toBe(false);
            expect(s.epoch).toBe(5000);
            expect(s.headroom()).toBe(Scheduler.MaxHeadroom);
        });

        it("should allow tasks to be re-registered after restore", () => {
            const s = new Scheduler();
            s.polltime(1000);

            let called = false;
            const t = s.newTask(() => {
                called = true;
            });
            t.schedule(100);

            // Restore to a different epoch
            s.restoreState({ epoch: 5000 });
            expect(t.scheduled()).toBe(false);

            // Re-register the task
            t.schedule(50);
            expect(t.scheduled()).toBe(true);
            expect(s.headroom()).toBe(50);

            s.polltime(50);
            expect(called).toBe(true);
            expect(s.epoch).toBe(5050);
        });
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
