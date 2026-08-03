import { describe, it, expect } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { WdFdc } from "../../src/wd-fdc.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Disc, DiscConfig } from "../../src/disc.js";
import { fake6502 } from "../../src/fake6502.js";

const ControlRegister = 0;
const CommandRegister = 4;
const StatusRegister = 4;
const TrackRegister = 5;
const DataRegister = 7;

// Reset is active low, so 0x20 releases it; 0x01 selects drive 0.
const ControlRunningDrive0 = 0x21;

const StatusBusy = 0x01;

const ForceInterrupt = 0xd0;
// Seek, with the spin-up wait disabled so the seek starts without six revolutions of delay.
const SeekCommand = 0x18;

// The drive schedules its first pulse callback one tick after it starts spinning.
const TicksForFirstPulse = 1000;
// Part way into a seek step, which is 6ms at the default rate and two ticks per microsecond.
const TicksMidSeekStep = 6000;
// Comfortably more than the 32us the controller takes to report a command as complete.
const TicksForCommandCompletion = 1000;

/**
 * A drive with no disc holds its index line permanently asserted, so the controller sees exactly
 * one index pulse edge: the first callback after the motor starts.
 *
 * @param {boolean} withDisc whether to load a blank disc, needed for anything that reads the surface
 */
function makeFdc(withDisc = false) {
    const cpu = fake6502();
    const scheduler = new Scheduler();
    const drives = [new DiscDrive(0, scheduler), new DiscDrive(1, scheduler)];
    if (withDisc) drives[0].setDisc(new Disc(true, new DiscConfig(), "test.ssd"));
    const fdc = new WdFdc(cpu, scheduler, drives, {});
    fdc.write(ControlRegister, ControlRunningDrive0);
    return { cpu, scheduler, fdc };
}

describe("WD1770 FDC tests", () => {
    describe("force interrupt", () => {
        it("does not interrupt for &D0", () => {
            const { cpu, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt);
            expect(cpu.nmi).toBe(false);
        });

        it("interrupts immediately for &D8", () => {
            const { cpu, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt | 0x08);
            expect(cpu.nmi).toBe(true);
        });

        it("aborts a seek in progress and interrupts for &D8", () => {
            const { cpu, scheduler, fdc } = makeFdc(true);
            fdc.write(TrackRegister, 0);
            fdc.write(DataRegister, 40);
            fdc.write(CommandRegister, SeekCommand);
            scheduler.polltime(TicksMidSeekStep);
            expect(fdc.read(StatusRegister) & StatusBusy).toBe(StatusBusy);

            fdc.write(CommandRegister, ForceInterrupt | 0x08);
            expect(cpu.nmi).toBe(true);

            // The completion timer must clear busy without swallowing the interrupt.
            scheduler.polltime(TicksForCommandCompletion);
            expect(cpu.nmi).toBe(true);
            expect(fdc.read(StatusRegister) & StatusBusy).toBe(0);
        });

        it("interrupts on the next index pulse for &D4", () => {
            const { cpu, scheduler, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt | 0x04);
            expect(cpu.nmi).toBe(false);
            scheduler.polltime(TicksForFirstPulse);
            expect(cpu.nmi).toBe(true);
        });

        it("interrupts immediately and on the next index pulse for &DC", () => {
            const { cpu, scheduler, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt | 0x0c);
            expect(cpu.nmi).toBe(true);

            // Reading the status register drops INTRQ, so a second one must be the index pulse.
            fdc.read(StatusRegister);
            expect(cpu.nmi).toBe(false);
            scheduler.polltime(TicksForFirstPulse);
            expect(cpu.nmi).toBe(true);
        });

        it("stops interrupting on index pulses once &D0 disarms it", () => {
            const { cpu, scheduler, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt | 0x04);
            fdc.write(CommandRegister, ForceInterrupt);
            scheduler.polltime(TicksForFirstPulse);
            expect(cpu.nmi).toBe(false);
        });

        it.each([...Array(16).keys()])("accepts force interrupt flags %i when idle", (bits) => {
            const { fdc } = makeFdc();
            expect(() => fdc.write(CommandRegister, ForceInterrupt | bits)).not.toThrow();
        });

        it.each([...Array(16).keys()])("accepts force interrupt flags %i during a seek", (bits) => {
            const { scheduler, fdc } = makeFdc(true);
            fdc.write(TrackRegister, 0);
            fdc.write(DataRegister, 40);
            fdc.write(CommandRegister, SeekCommand);
            scheduler.polltime(TicksMidSeekStep);
            expect(() => fdc.write(CommandRegister, ForceInterrupt | bits)).not.toThrow();
        });
    });
});
