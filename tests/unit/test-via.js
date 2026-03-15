import { describe, it, expect, beforeEach } from "vitest";
import { SysVia, UserVia } from "../../src/via.js";
import { Scheduler } from "../../src/scheduler.js";

function makeFakeCpu() {
    return { interrupt: 0 };
}

function makeFakeVideo() {
    return { setScreenHwScroll: () => {} };
}

function makeFakeSoundChip() {
    return { updateSlowDataBus: () => {} };
}

function makeFakeCmos() {
    return { writeControl: () => {}, read: () => 0xff };
}

function makeFakeUserPortPeripheral() {
    return { read: () => 0xff, write: () => {} };
}

describe("Via snapshotState / restoreState", () => {
    let scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
    });

    describe("base Via (via UserVia)", () => {
        function makeUserVia() {
            return new UserVia(cpu, scheduler, false, makeFakeUserPortPeripheral());
        }

        it("should snapshot and restore all register fields", () => {
            const via = makeUserVia();
            // Set some non-default state
            via.ora = 0x42;
            via.orb = 0x37;
            via.ira = 0xaa;
            via.irb = 0xbb;
            via.ddra = 0xf0;
            via.ddrb = 0x0f;
            via.sr = 0x55;
            via.acr = 0x60;
            via.pcr = 0x22;
            via.t1hit = false;
            via.t2hit = false;
            via.t1_pb7 = 1;
            via.ca1 = true;
            via.cb2 = true;

            const snapshot = via.snapshotState();

            // Create a fresh VIA and restore
            const via2 = makeUserVia();
            via2.restoreState(snapshot);

            expect(via2.ora).toBe(0x42);
            expect(via2.orb).toBe(0x37);
            expect(via2.ira).toBe(0xaa);
            expect(via2.irb).toBe(0xbb);
            expect(via2.ddra).toBe(0xf0);
            expect(via2.ddrb).toBe(0x0f);
            expect(via2.sr).toBe(0x55);
            expect(via2.acr).toBe(0x60);
            expect(via2.pcr).toBe(0x22);
            expect(via2.t1hit).toBe(false);
            expect(via2.t2hit).toBe(false);
            expect(via2.t1_pb7).toBe(1);
            expect(via2.ca1).toBe(true);
            expect(via2.cb2).toBe(true);
        });

        it("should snapshot and restore timer state", () => {
            const via = makeUserVia();
            via.t1c = 12345;
            via.t1l = 67890;
            via.t2c = 11111;
            via.t2l = 22222;

            const snapshot = via.snapshotState();
            const via2 = makeUserVia();
            via2.restoreState(snapshot);

            expect(via2.t1c).toBe(12345);
            expect(via2.t1l).toBe(67890);
            expect(via2.t2c).toBe(11111);
            expect(via2.t2l).toBe(22222);
        });

        it("should save task offset when task is scheduled", () => {
            const via = makeUserVia();
            // After reset, the via task should be scheduled
            expect(via.task.scheduled()).toBe(true);

            const snapshot = via.snapshotState();
            expect(snapshot.taskOffset).not.toBeNull();
            // Task offset should be positive (relative to epoch)
            expect(snapshot.taskOffset).toBeGreaterThan(0);
        });

        it("should save null task offset when task is not scheduled", () => {
            const via = makeUserVia();
            via.task.cancel();

            const snapshot = via.snapshotState();
            expect(snapshot.taskOffset).toBeNull();
        });

        it("should re-register task with correct offset on restore", () => {
            const via = makeUserVia();
            scheduler.polltime(1000);
            via._catchUp();

            // Set up a known timer state
            via.t1c = 500;
            via.t1l = 500;
            via.updateNextTime();

            const snapshot = via.snapshotState();
            expect(snapshot.taskOffset).not.toBeNull();
            const expectedOffset = snapshot.taskOffset;

            // Restore to a new VIA on same scheduler
            const via2 = makeUserVia();
            via2.restoreState(snapshot);

            expect(via2.task.scheduled()).toBe(true);
            // The task should expire at epoch + offset
            expect(via2.task.expireEpoch).toBe(scheduler.epoch + expectedOffset);
        });

        it("should restore interrupt state correctly", () => {
            const via = makeUserVia();
            via.ier = 0x60; // Enable timer 1 and 2 interrupts
            via.ifr = 0x40; // Timer 1 interrupt pending
            via.updateIFR();
            expect(cpu.interrupt & 0x02).toBe(0x02); // UserVia uses irq=0x02

            const snapshot = via.snapshotState();

            // Reset CPU interrupt state
            cpu.interrupt = 0;
            const via2 = makeUserVia();
            via2.restoreState(snapshot);

            // Interrupt should be re-asserted
            expect(cpu.interrupt & 0x02).toBe(0x02);
        });
    });

    describe("SysVia", () => {
        function makeSysVia() {
            return new SysVia(cpu, scheduler, {
                video: makeFakeVideo(),
                soundChip: makeFakeSoundChip(),
                cmos: makeFakeCmos(),
                isMaster: false,
                initialLayout: "physical",
            });
        }

        it("should snapshot and restore SysVia-specific fields", () => {
            const via = makeSysVia();
            via.IC32 = 0xab;
            via.capsLockLight = true;
            via.shiftLockLight = true;

            const snapshot = via.snapshotState();
            expect(snapshot.IC32).toBe(0xab);
            expect(snapshot.capsLockLight).toBe(true);
            expect(snapshot.shiftLockLight).toBe(true);

            const via2 = makeSysVia();
            via2.restoreState(snapshot);

            expect(via2.IC32).toBe(0xab);
            expect(via2.capsLockLight).toBe(true);
            expect(via2.shiftLockLight).toBe(true);
        });

        it("should include base Via fields in SysVia snapshot", () => {
            const via = makeSysVia();
            via.ora = 0x77;
            via.acr = 0x40;

            const snapshot = via.snapshotState();
            expect(snapshot.ora).toBe(0x77);
            expect(snapshot.acr).toBe(0x40);
            expect(snapshot.IC32).toBeDefined();
        });
    });
});
