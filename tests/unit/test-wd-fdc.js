import { describe, it, expect } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { WdFdc } from "../../src/wd-fdc.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Disc, DiscConfig, IbmDiscFormat } from "../../src/disc.js";
import { fake6502 } from "../../src/fake6502.js";

const ControlRegister = 0;
const CommandRegister = 4;
const StatusRegister = 4;
const TrackRegister = 5;
const DataRegister = 7;

// Reset is active low, so 0x20 releases it; 0x01 selects drive 0.
const ControlRunningDrive0 = 0x21;
// Density is active low too, so this is single density.
const ControlRunningDrive0Fm = 0x29;

const StatusBusy = 0x01;
const StatusDrq = 0x02;
const StatusCrcError = 0x08;

const ForceInterrupt = 0xd0;
// The whole low nibble, including the ready line bits the BBC can never exercise.
const AllFlagCombinations = [...Array(16).keys()];
// Seek, with the spin-up wait disabled so the seek starts without six revolutions of delay.
const SeekCommand = 0x18;
// Read track, also without the spin-up wait.
const ReadTrackCommand = 0xe8;

// Long enough to reach the drive's first pulse callback and to outlast the 32us the controller
// takes to report a command as complete, but still well inside a seek's first step.
const ShortWaitTicks = 1000;
// Well inside the 64us an FM byte takes, so no byte is lost between polls.
const PollTicks = 16;
const SectorLengthCode = 1;

/**
 * A drive with no disc holds its index line permanently asserted, so the controller sees exactly
 * one index pulse edge: the first callback after the motor starts.
 *
 * @param {boolean} withDisc whether to load a blank disc, needed for anything that reads the surface
 */
function makeFdc(withDisc = false, control = ControlRunningDrive0) {
    const cpu = fake6502();
    const scheduler = new Scheduler();
    const drives = [new DiscDrive(0, scheduler), new DiscDrive(1, scheduler)];
    if (withDisc) drives[0].setDisc(new Disc(true, new DiscConfig(), "test.ssd"));
    const fdc = new WdFdc(cpu, scheduler, drives, {});
    fdc.write(ControlRegister, control);
    return { cpu, scheduler, fdc };
}

/** One FM sector on track 0, laid out as DFS formats it. */
function formatFmSector(disc) {
    const sectorData = new Uint8Array(256).map((_, i) => i & 0xff);
    disc.buildTrack(false, 0)
        .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap1FFs)
        .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
        .resetCrc()
        .appendFmDataAndClocks(IbmDiscFormat.idMarkDataPattern, IbmDiscFormat.markClockPattern)
        .appendFmByte(0)
        .appendFmByte(0)
        .appendFmByte(0)
        .appendFmByte(SectorLengthCode)
        .appendCrc(false)
        .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap2FFs)
        .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
        .resetCrc()
        .appendFmDataAndClocks(IbmDiscFormat.dataMarkDataPattern, IbmDiscFormat.markClockPattern)
        .appendFmChunk(sectorData)
        .appendCrc(false)
        .fillFmByte(0xff);
}

/** Issues a command and polls until busy drops, taking every byte the controller offers. */
function runCommand(fdc, scheduler, command) {
    const bytes = [];
    const takeByte = () => {
        if (fdc.read(StatusRegister) & StatusDrq) bytes.push(fdc.read(DataRegister));
    };
    fdc.write(CommandRegister, command);
    do {
        takeByte();
        scheduler.polltime(PollTicks);
    } while (fdc.read(StatusRegister) & StatusBusy);
    takeByte();
    return { bytes, status: fdc.read(StatusRegister) };
}

function hex(bytes) {
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
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
            scheduler.polltime(ShortWaitTicks);
            expect(fdc.read(StatusRegister) & StatusBusy).toBe(StatusBusy);

            fdc.write(CommandRegister, ForceInterrupt | 0x08);
            expect(cpu.nmi).toBe(true);

            // The completion timer must clear busy without swallowing the interrupt.
            scheduler.polltime(ShortWaitTicks);
            expect(cpu.nmi).toBe(true);
            expect(fdc.read(StatusRegister) & StatusBusy).toBe(0);
        });

        it("interrupts on the next index pulse for &D4", () => {
            const { cpu, scheduler, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt | 0x04);
            expect(cpu.nmi).toBe(false);
            scheduler.polltime(ShortWaitTicks);
            expect(cpu.nmi).toBe(true);
        });

        it("interrupts immediately and on the next index pulse for &DC", () => {
            const { cpu, scheduler, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt | 0x0c);
            expect(cpu.nmi).toBe(true);

            // Reading the status register drops INTRQ, so a second one must be the index pulse.
            fdc.read(StatusRegister);
            expect(cpu.nmi).toBe(false);
            scheduler.polltime(ShortWaitTicks);
            expect(cpu.nmi).toBe(true);
        });

        it("stops interrupting on index pulses once &D0 disarms it", () => {
            const { cpu, scheduler, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt | 0x04);
            fdc.write(CommandRegister, ForceInterrupt);
            scheduler.polltime(ShortWaitTicks);
            expect(cpu.nmi).toBe(false);
        });

        it("accepts every combination of flags when idle", () => {
            for (const bits of AllFlagCombinations) {
                const { fdc } = makeFdc();
                expect(() => fdc.write(CommandRegister, ForceInterrupt | bits)).not.toThrow();
            }
        });

        it("accepts every combination of flags during a seek", () => {
            for (const bits of AllFlagCombinations) {
                const { scheduler, fdc } = makeFdc(true);
                fdc.write(TrackRegister, 0);
                fdc.write(DataRegister, 40);
                fdc.write(CommandRegister, SeekCommand);
                scheduler.polltime(ShortWaitTicks);
                expect(() => fdc.write(CommandRegister, ForceInterrupt | bits)).not.toThrow();
            }
        });
    });

    describe("read track", () => {
        it("streams a whole revolution, gaps and marks included, without a CRC check", () => {
            const { scheduler, fdc } = makeFdc(true, ControlRunningDrive0Fm);
            formatFmSector(fdc.drives[0].disc);
            const { bytes, status } = runCommand(fdc, scheduler, ReadTrackCommand);
            expect(status & StatusCrcError).toBe(0);
            expect(bytes.length).toBeGreaterThan(IbmDiscFormat.bytesPerTrack * 0.9);
            expect(hex(bytes)).toContain("fe00000001");
            expect(hex(bytes)).toContain("fb000102030405");
        });
    });
});
