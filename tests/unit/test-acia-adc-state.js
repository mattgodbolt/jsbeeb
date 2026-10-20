import { describe, it, expect, beforeEach } from "vitest";
import { Acia } from "../../src/acia.js";
import { Adc } from "../../src/adc.js";
import { Scheduler } from "../../src/scheduler.js";
import { findModel } from "../../src/models.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";

const ReceiveInterruptEightBitWord = 0x95;
const CarrierPollsToRaiseDcd = 209;
const StartEightBitConversionOnChannel1 = 0x01;
const StartTenBitConversionOnChannel2 = 0x0a;
const EightBitConversionCycles = 8000;

describe("Acia snapshotState / restoreState", () => {
    let scheduler, cpu, acia;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = { interrupt: 0, model: findModel("B-DFS1.2") };
        const toneGen = { mute: () => {}, tone: () => {} };
        acia = new Acia(cpu, toneGen, scheduler);
    });

    it("round-trips an ACIA sending, receiving and running a tape with its carrier up", async () => {
        const quiet = { mute: () => {}, tone: () => {} };
        const relayNoise = { motorOn: () => {}, motorOff: () => {} };
        await expectSnapshotRoundTrips(
            () => new Acia(cpu, quiet, scheduler, relayNoise),
            (driven) => {
                driven.write(0, ReceiveInterruptEightBitWord);
                driven.setSerialReceive(9600);
                driven.setSerialTransmit(1200);
                scheduler.polltime(1000);
                driven.write(1, 0x42);
                driven.receive(0x5a);
                driven.setTape({ poll: () => 100 });
                driven.setMotor(true);
                for (let i = 0; i < CarrierPollsToRaiseDcd; ++i) driven.setTapeCarrier(true);
                driven.selectRs423(true);
            },
        );
    });

    it("keeps the recorder's PLAY latch, and restores an older snapshot with PLAY down", () => {
        acia.pressStop();
        const snapshot = acia.snapshotState();
        expect(snapshot.playPressed).toBe(false);

        const acia2 = new Acia(cpu, { mute: () => {}, tone: () => {} }, scheduler);
        acia2.restoreState(snapshot);
        expect(acia2.playPressed).toBe(false);

        acia2.restoreState({ ...snapshot, playPressed: undefined });
        expect(acia2.playPressed).toBe(true);
    });

    it("derives the byte times from the restored rates", () => {
        acia.setSerialReceive(9600);
        acia.setSerialTransmit(1200);

        const snapshot = acia.snapshotState();
        const acia2 = new Acia(cpu, { mute: () => {}, tone: () => {} }, scheduler);
        acia2.restoreState(snapshot);

        expect(acia2.serialReceiveCyclesPerByte).toBe(acia.serialReceiveCyclesPerByte);
        expect(acia2.serialTransmitCyclesPerByte).toBe(acia.serialTransmitCyclesPerByte);
    });

    it("should restore interrupt state", () => {
        cpu.interrupt = 0;
        acia.sr = 0x82; // RDRF + IRQ
        acia.cr = 0x80; // RIE
        acia.updateIrq();
        expect(cpu.interrupt & 0x04).toBe(0x04);

        const snapshot = acia.snapshotState();
        cpu.interrupt = 0;

        const acia2 = new Acia(cpu, { mute: () => {}, tone: () => {} }, scheduler);
        acia2.restoreState(snapshot);
        expect(cpu.interrupt & 0x04).toBe(0x04);
    });
});

describe("Adc snapshotState / restoreState", () => {
    it("round-trips a converter part way through its second conversion", async () => {
        const scheduler = new Scheduler();
        const sysvia = { setcb1: () => {} };
        await expectSnapshotRoundTrips(
            () => new Adc(sysvia, scheduler),
            (adc) => {
                adc.setFixedValue(0x1234);
                adc.write(0, StartEightBitConversionOnChannel1);
                scheduler.polltime(EightBitConversionCycles);
                adc.write(0, StartTenBitConversionOnChannel2);
                scheduler.polltime(100);
            },
        );
    });
});
