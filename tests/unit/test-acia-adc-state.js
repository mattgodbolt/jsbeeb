import { describe, it, expect, beforeEach } from "vitest";
import { Acia } from "../../src/acia.js";
import { Adc } from "../../src/adc.js";
import { Scheduler } from "../../src/scheduler.js";

describe("Acia snapshotState / restoreState", () => {
    let scheduler, cpu, acia;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = { interrupt: 0 };
        const toneGen = { mute: () => {}, tone: () => {} };
        acia = new Acia(cpu, toneGen, scheduler, null);
    });

    it("should snapshot and restore register state", () => {
        acia.sr = 0x82;
        acia.cr = 0x15;
        acia.dr = 0x42;
        acia.rs423Selected = true;
        acia.motorOn = true;
        acia.tapeCarrierCount = 100;
        acia.tapeDcdLineLevel = true;
        acia.hadDcdHigh = true;

        const snapshot = acia.snapshotState();

        const acia2 = new Acia(cpu, { mute: () => {}, tone: () => {} }, scheduler, null);
        acia2.restoreState(snapshot);

        expect(acia2.sr).toBe(0x82);
        expect(acia2.cr).toBe(0x15);
        expect(acia2.dr).toBe(0x42);
        expect(acia2.rs423Selected).toBe(true);
        expect(acia2.motorOn).toBe(true);
        expect(acia2.tapeCarrierCount).toBe(100);
        expect(acia2.tapeDcdLineLevel).toBe(true);
        expect(acia2.hadDcdHigh).toBe(true);
    });

    it("should snapshot and restore serial rate", () => {
        acia.setSerialReceive(9600);

        const snapshot = acia.snapshotState();
        const acia2 = new Acia(cpu, { mute: () => {}, tone: () => {} }, scheduler, null);
        acia2.restoreState(snapshot);

        expect(acia2.serialReceiveRate).toBe(9600);
        expect(acia2.serialReceiveCyclesPerByte).toBe(acia.serialReceiveCyclesPerByte);
    });

    it("should snapshot scheduled task offsets", () => {
        // Schedule the tx complete task
        acia.txCompleteTask.schedule(500);

        const snapshot = acia.snapshotState();
        expect(snapshot.txCompleteTaskOffset).toBe(500);
        expect(snapshot.runTapeTaskOffset).toBeNull();
        expect(snapshot.runRs423TaskOffset).toBeNull();
    });

    it("should restore and re-register tasks", () => {
        acia.txCompleteTask.schedule(500);
        const snapshot = acia.snapshotState();

        const acia2 = new Acia(cpu, { mute: () => {}, tone: () => {} }, scheduler, null);
        acia2.restoreState(snapshot);

        expect(acia2.txCompleteTask.scheduled()).toBe(true);
        expect(acia2.txCompleteTask.expireEpoch).toBe(scheduler.epoch + 500);
    });

    it("should restore interrupt state", () => {
        cpu.interrupt = 0;
        acia.sr = 0x82; // RDRF + IRQ
        acia.cr = 0x80; // RIE
        acia.updateIrq();
        expect(cpu.interrupt & 0x04).toBe(0x04);

        const snapshot = acia.snapshotState();
        cpu.interrupt = 0;

        const acia2 = new Acia(cpu, { mute: () => {}, tone: () => {} }, scheduler, null);
        acia2.restoreState(snapshot);
        expect(cpu.interrupt & 0x04).toBe(0x04);
    });
});

describe("Adc snapshotState / restoreState", () => {
    let scheduler, sysvia, adc;

    beforeEach(() => {
        scheduler = new Scheduler();
        sysvia = { setcb1: () => {} };
        adc = new Adc(sysvia, scheduler);
    });

    it("should snapshot and restore register state", () => {
        adc.status = 0x83;
        adc.low = 0xab;
        adc.high = 0xcd;

        const snapshot = adc.snapshotState();
        const adc2 = new Adc(sysvia, scheduler);
        adc2.restoreState(snapshot);

        expect(adc2.status).toBe(0x83);
        expect(adc2.low).toBe(0xab);
        expect(adc2.high).toBe(0xcd);
    });

    it("should snapshot task offset when conversion in progress", () => {
        // Trigger a conversion
        adc.write(0, 0x08); // 10-bit conversion
        expect(adc.task.scheduled()).toBe(true);

        const snapshot = adc.snapshotState();
        expect(snapshot.taskOffset).not.toBeNull();
        expect(snapshot.taskOffset).toBeGreaterThan(0);
    });

    it("should snapshot null task offset when idle", () => {
        const snapshot = adc.snapshotState();
        expect(snapshot.taskOffset).toBeNull();
    });

    it("should restore and re-register task", () => {
        const snapshot = { status: 0x83, low: 0, high: 0, taskOffset: 1000 };
        const adc2 = new Adc(sysvia, scheduler);
        adc2.restoreState(snapshot);

        expect(adc2.task.scheduled()).toBe(true);
        expect(adc2.task.expireEpoch).toBe(scheduler.epoch + 1000);
    });
});
