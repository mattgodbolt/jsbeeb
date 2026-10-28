import { describe, it, expect } from "vitest";
import { Scheduler } from "../../src/scheduler.js";

describe("Scheduler tests", function () {
    const recordingTasks = (s, delays) => {
        const called = [];
        const tasks = delays.map((delay, i) => {
            const task = s.newTask(() => called.push("abc"[i]));
            task.schedule(delay);
            return task;
        });
        return { tasks, called: () => called.join("") };
    };

    it.each([[[1, 1, 1]], [[2, 2]], [[3, 3]]])("calls a task once, when its time comes, stepping by %j", (steps) => {
        const s = new Scheduler();
        let calls = 0;
        s.newTask(() => ++calls).schedule(2);
        let elapsed = 0;
        for (const step of steps) {
            s.polltime(step);
            elapsed += step;
            expect(calls).toBe(elapsed >= 2 ? 1 : 0);
        }
    });

    it.each([
        ["in the order registered when on the same cycle", [2, 2, 2], "abc"],
        ["registered in reverse (CBA) order", [4, 3, 2], "cba"],
        ["registered in CAB order", [3, 4, 2], "cab"],
    ])("calls tasks %s", (_, delays, expected) => {
        const s = new Scheduler();
        const { called } = recordingTasks(s, delays);
        s.polltime(10);
        expect(called()).toBe(expected);
    });

    it.each([
        ["first", 0, "bc"],
        ["middle", 1, "ac"],
        ["last", 2, "ab"],
    ])("cancels the %s of three tasks on the same cycle", (_, index, expected) => {
        const s = new Scheduler();
        const { tasks, called } = recordingTasks(s, [2, 2, 2]);
        tasks[index].cancel();
        s.polltime(2);
        expect(called()).toBe(expected);
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

        it("should cancel existing tasks on restore, and allow them to be re-registered", () => {
            const s = new Scheduler();
            s.polltime(1000);

            let called = false;
            const t = s.newTask(() => {
                called = true;
            });
            t.schedule(100);

            s.restoreState({ epoch: 5000 });
            expect(t.scheduled()).toBe(false);
            expect(s.headroom()).toBe(Scheduler.MaxHeadroom);

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
