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
const SectorRegister = 6;
const DataRegister = 7;

// Reset is active low, so 0x20 releases it; 0x01 selects drive 0. Density is active low too, so
// this is double density.
const ControlRunningDrive0 = 0x21;
const ControlRunningDrive0Fm = 0x29;

const StatusBusy = 0x01;
const StatusDrq = 0x02;
const StatusLostData = 0x04;
const StatusCrcError = 0x08;
const StatusRecordNotFound = 0x10;
const StatusDeletedMark = 0x20;

const ForceInterrupt = 0xd0;
// The whole low nibble, including the ready line bits the BBC can never exercise.
const AllFlagCombinations = [...Array(16).keys()];
// Type I, II and III commands with the spin-up wait disabled so they start without six
// revolutions of delay.
const SeekCommand = 0x18;
const ReadSectorCommand = 0x88;
const ReadAddressCommand = 0xc8;
const ReadTrackCommand = 0xe8;
// The e flag adds the head settle delay after spin-up.
const SettleFlag = 0x04;
const SpinUpWaitFlag = 0x08;

const TicksPerMs = 2000;
const DoneTimerTicks = 64;
// Long enough to reach the drive's first pulse callback and to outlast the 32us the controller
// takes to report a command as complete, but still well inside a seek's first step.
const ShortWaitTicks = 1000;
const MfmByteTicks = 64;
// Well inside the 32us an MFM byte takes, so no byte is lost between polls.
const PollTicks = 16;
// A type II command gives up after five revolutions, so a command still busy after ten has hung.
const MaxCommandTicks = 10 * DiscDrive.TicksPerRevolution;

const IdMark = IbmDiscFormat.idMarkDataPattern;
const DataMark = IbmDiscFormat.dataMarkDataPattern;
const IndexMark = 0xfc;
const FmIndexMarkClocks = 0xd7;
const SectorLengthCode = 1;
const SectorBytes = 256;
const IndexMarkGap = 50;
const SectorGap = 22;

function blankDisc() {
    return new Disc(true, new DiscConfig(), "test.ssd");
}

/**
 * A drive with no disc holds its index line permanently asserted, so the controller sees exactly
 * one index pulse edge: the first callback after the motor starts.
 *
 * @param {{disc?: Disc|null, control?: Number, controlRegister?: Number, variant?: {is1772?: boolean, isOpus?: boolean}}} [options]
 *   the disc in drive 0 if any, the first control register write and where it goes, and the
 *   controller variant
 */
function makeFdc({
    disc = null,
    control = ControlRunningDrive0,
    controlRegister = ControlRegister,
    variant = {},
} = {}) {
    const cpu = fake6502();
    const scheduler = new Scheduler();
    const drives = [new DiscDrive(0, scheduler), new DiscDrive(1, scheduler)];
    if (disc) drives[0].setDisc(disc);
    const fdc = new WdFdc(cpu, scheduler, drives, {}, variant);
    fdc.write(controlRegister, control);
    return { cpu, scheduler, fdc };
}

/**
 * Issues a command and polls until the controller drops busy, taking every byte it offers.
 *
 * @returns {{bytes: Number[], status: Number, ticks: Number}} the bytes read, the final status and
 *   how long the command took
 */
function runCommand(fdc, scheduler, command, { commandRegister = CommandRegister, dataRegister = DataRegister } = {}) {
    const bytes = [];
    const takeByte = () => {
        if (fdc.read(commandRegister) & StatusDrq) bytes.push(fdc.read(dataRegister));
    };
    const start = scheduler.epoch;
    fdc.write(commandRegister, command);
    do {
        takeByte();
        scheduler.polltime(PollTicks);
        if (scheduler.epoch - start > MaxCommandTicks) throw new Error(`Command ${command} never finished`);
    } while (fdc.read(commandRegister) & StatusBusy);
    takeByte();
    return { bytes, status: fdc.read(commandRegister), ticks: scheduler.epoch - start };
}

function hex(bytes) {
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sectorData() {
    return new Uint8Array(SectorBytes).map((_, i) => i & 0xff);
}

// Runs whose MFM encoding contains the 0x00 then 0xc2 sync pattern at some bit offset.
const DataMimickingC2Sync = [0x01, 0xfe, 0x29, 0x07, 0xf8, 0xa4];

function appendFmSector(builder, { idMark = IdMark, dataMark = DataMark, sector = 0 }) {
    return builder
        .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap1FFs)
        .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
        .resetCrc()
        .appendFmDataAndClocks(idMark, IbmDiscFormat.markClockPattern)
        .appendFmByte(0)
        .appendFmByte(0)
        .appendFmByte(sector)
        .appendFmByte(SectorLengthCode)
        .appendCrc(false)
        .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap2FFs)
        .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
        .resetCrc()
        .appendFmDataAndClocks(dataMark, IbmDiscFormat.markClockPattern)
        .appendFmChunk(sectorData())
        .appendCrc(false);
}

function appendMfmSector(builder, { idMark = IdMark, dataMark = DataMark, sector = 0, data = sectorData() }) {
    return builder
        .appendRepeatMfmByte(0x4e, SectorGap)
        .appendRepeatMfmByte(0x00, 12)
        .resetCrc()
        .appendMfm3xA1Sync()
        .appendMfmByte(idMark)
        .appendMfmByte(0)
        .appendMfmByte(0)
        .appendMfmByte(sector)
        .appendMfmByte(SectorLengthCode)
        .appendCrc(true)
        .appendRepeatMfmByte(0x4e, SectorGap)
        .appendRepeatMfmByte(0x00, 12)
        .resetCrc()
        .appendMfm3xA1Sync()
        .appendMfmByte(dataMark)
        .appendMfmChunk(data)
        .appendCrc(true);
}

function appendMfmIndexMark(builder) {
    builder.appendRepeatMfmByte(0x4e, 60).appendRepeatMfmByte(0x00, 12);
    for (let i = 0; i < 3; ++i) builder.appendMfmPulses(IbmDiscFormat.mfmC2Sync);
    return builder.appendMfmByte(IndexMark).appendRepeatMfmByte(0x4e, IndexMarkGap);
}

function fmDiscWithSector(marks) {
    const disc = blankDisc();
    appendFmSector(disc.buildTrack(false, 0), marks).fillFmByte(0xff);
    return disc;
}

function mfmDiscWithSector(marks) {
    const disc = blankDisc();
    appendMfmSector(disc.buildTrack(false, 0).appendRepeatMfmByte(0x4e, 60), marks).fillMfmByte(0x4e);
    return disc;
}

/**
 * The head reads the surface in aligned 16 or 32 bit words, so a track built a word at a time is
 * byte-aligned from the moment the motor starts. Rotating its bits leaves the controller no
 * alignment it did not find for itself.
 */
function rotateTrackBits(track, bits) {
    const words = track.pulses2Us.subarray(0, track.length);
    const rotated = words.map((word, i) => {
        const next = words[(i + 1) % words.length];
        return ((word << bits) | (next >>> (32 - bits))) >>> 0;
    });
    words.set(rotated);
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
            const { cpu, scheduler, fdc } = makeFdc({ disc: blankDisc() });
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
                const { scheduler, fdc } = makeFdc({ disc: blankDisc() });
                fdc.write(TrackRegister, 0);
                fdc.write(DataRegister, 40);
                fdc.write(CommandRegister, SeekCommand);
                scheduler.polltime(ShortWaitTicks);
                expect(() => fdc.write(CommandRegister, ForceInterrupt | bits)).not.toThrow();
            }
        });
    });

    describe("address marks", () => {
        it.each([
            ["FM", fmDiscWithSector, ControlRunningDrive0Fm, IdMark, 0xfa, 0],
            ["FM", fmDiscWithSector, ControlRunningDrive0Fm, IdMark, 0xf9, StatusDeletedMark],
            ["MFM", mfmDiscWithSector, ControlRunningDrive0, 0xfc, 0xfa, 0],
            ["MFM", mfmDiscWithSector, ControlRunningDrive0, 0xff, 0xf9, StatusDeletedMark],
        ])(
            "reads an %s sector marked with the alternate values",
            (_, discWith, control, idMark, dataMark, expected) => {
                const { scheduler, fdc } = makeFdc({ disc: discWith({ idMark, dataMark }), control });
                fdc.write(SectorRegister, 0);
                const { bytes, status } = runCommand(fdc, scheduler, ReadSectorCommand);
                expect(bytes).toEqual([...sectorData()]);
                expect(status & (StatusDeletedMark | StatusCrcError | StatusRecordNotFound | StatusLostData)).toBe(
                    expected,
                );
            },
        );

        it("streams a whole FM revolution, gaps and marks included, without a CRC check", () => {
            const { scheduler, fdc } = makeFdc({ disc: fmDiscWithSector({}), control: ControlRunningDrive0Fm });
            const { bytes, status } = runCommand(fdc, scheduler, ReadTrackCommand);
            expect(status & StatusCrcError).toBe(0);
            expect(bytes.length).toBeGreaterThan(IbmDiscFormat.bytesPerTrack * 0.9);
            expect(hex(bytes)).toContain("fe00000001");
            expect(hex(bytes)).toContain("fb000102030405");
        });

        it("keeps read track byte-aligned across an MFM index mark", () => {
            const disc = blankDisc();
            const builder = appendMfmIndexMark(disc.buildTrack(false, 0));
            appendMfmSector(builder, {}).fillMfmByte(0x4e);
            rotateTrackBits(builder.track, 5);
            const { scheduler, fdc } = makeFdc({ disc });
            const { bytes } = runCommand(fdc, scheduler, ReadTrackCommand);
            expect(hex(bytes)).toContain(`c2c2c2fc${"4e".repeat(IndexMarkGap + SectorGap)}0000`);
            expect(hex(bytes)).toContain(`a1a1a1fe00000001`);
        });

        it("does not resync on data that looks like an index sync", () => {
            const data = sectorData();
            data.set(DataMimickingC2Sync, 100);
            const { scheduler, fdc } = makeFdc({ disc: mfmDiscWithSector({ data }) });
            fdc.write(SectorRegister, 0);
            const { bytes, status } = runCommand(fdc, scheduler, ReadSectorCommand);
            expect(bytes).toEqual([...data]);
            expect(status & StatusCrcError).toBe(0);
        });

        it("does not take an MFM index mark for a sector ID", () => {
            const disc = blankDisc();
            appendMfmSector(appendMfmIndexMark(disc.buildTrack(false, 0)), { sector: 3 }).fillMfmByte(0x4e);
            const { scheduler, fdc } = makeFdc({ disc });
            const { bytes, status } = runCommand(fdc, scheduler, ReadAddressCommand);
            expect(bytes.slice(0, 4)).toEqual([0, 0, 3, SectorLengthCode]);
            expect(status & StatusCrcError).toBe(0);
        });

        it("does not take an FM index mark for a sector ID", () => {
            const disc = blankDisc();
            const builder = disc
                .buildTrack(false, 0)
                .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap1FFs)
                .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
                .appendFmDataAndClocks(IndexMark, FmIndexMarkClocks);
            appendFmSector(builder, { sector: 3 }).fillFmByte(0xff);
            const { scheduler, fdc } = makeFdc({ disc, control: ControlRunningDrive0Fm });
            const { bytes, status } = runCommand(fdc, scheduler, ReadAddressCommand);
            expect(bytes.slice(0, 4)).toEqual([0, 0, 3, SectorLengthCode]);
            expect(status & StatusCrcError).toBe(0);
        });
    });

    describe("variants", () => {
        describe("step rate", () => {
            it.each([
                [{}, 0, 6],
                [{}, 1, 12],
                [{}, 2, 20],
                [{}, 3, 30],
                [{ is1772: true }, 0, 6],
                [{ is1772: true }, 1, 12],
                [{ is1772: true }, 2, 2],
                [{ is1772: true }, 3, 3],
            ])("with %o steps one track at rate %i in %i ms", (variant, rate, ms) => {
                const { scheduler, fdc } = makeFdc({ disc: blankDisc(), variant });
                fdc.write(TrackRegister, 0);
                fdc.write(DataRegister, 1);
                const { ticks } = runCommand(fdc, scheduler, SeekCommand | rate);
                expect(ticks).toBeGreaterThanOrEqual(ms * TicksPerMs + DoneTimerTicks);
                expect(ticks).toBeLessThan(ms * TicksPerMs + DoneTimerTicks + 2 * PollTicks);
            });
        });

        describe("head settle", () => {
            // Read address finishes as soon as it sees an ID, so a track of nothing but IDs
            // shows the settle delay to within one ID's length.
            function discOfIds() {
                const disc = blankDisc();
                const builder = disc.buildTrack(false, 0);
                for (let sector = 0; sector < 250; ++sector) {
                    builder
                        .appendRepeatMfmByte(0x00, 12)
                        .resetCrc()
                        .appendMfm3xA1Sync()
                        .appendMfmByte(IdMark)
                        .appendMfmByte(0)
                        .appendMfmByte(0)
                        .appendMfmByte(sector)
                        .appendMfmByte(SectorLengthCode)
                        .appendCrc(true);
                }
                builder.fillMfmByte(0x4e);
                return disc;
            }
            const IdTicks = 22 * MfmByteTicks;

            function readAddressTicks(variant, command) {
                const { scheduler, fdc } = makeFdc({ disc: discOfIds(), variant });
                return runCommand(fdc, scheduler, command).ticks;
            }

            it.each([[{}], [{ is1772: true }]])("with %o the e flag delays a type III command by 15 ms", (variant) => {
                const command = ReadAddressCommand & ~SpinUpWaitFlag;
                const delay = readAddressTicks(variant, command | SettleFlag) - readAddressTicks(variant, command);
                expect(delay).toBeGreaterThan(15 * TicksPerMs - IdTicks);
                expect(delay).toBeLessThan(15 * TicksPerMs + IdTicks);
            });
        });

        describe("Opus Challenger", () => {
            // The Challenger puts the 1770 in the low half of the page and its control register in
            // the high half; bit 0 picks drive 1, bit 1 the side and bit 6 double density.
            const OpusControlRegister = 4;
            const OpusCommandRegister = 0;
            const OpusStatusRegister = 0;
            const OpusTrackRegister = 1;
            const OpusDataRegister = 3;
            const OpusDoubleDensity = 0x40;
            const OpusDrive1 = 0x01;

            function makeOpus(control, disc = null) {
                return makeFdc({ disc, control, controlRegister: OpusControlRegister, variant: { isOpus: true } });
            }

            it("keeps INTRQ off the NMI line", () => {
                const { cpu, fdc } = makeOpus(OpusDoubleDensity);
                fdc.write(OpusCommandRegister, ForceInterrupt | 0x08);
                expect(cpu.nmi).toBe(false);
            });

            it("raises the NMI for DRQ", () => {
                const { cpu, scheduler, fdc } = makeOpus(OpusDoubleDensity);
                fdc.write(OpusCommandRegister, ReadTrackCommand);
                scheduler.polltime(ShortWaitTicks);
                expect(fdc.read(OpusStatusRegister) & StatusDrq).toBe(StatusDrq);
                expect(cpu.nmi).toBe(true);
            });

            it("maps the registers to the low half of the page", () => {
                const { fdc } = makeOpus(OpusDoubleDensity);
                fdc.write(OpusTrackRegister, 42);
                expect(fdc.read(OpusTrackRegister)).toBe(42);
                expect(fdc.read(TrackRegister)).toBe(0xfe);
            });

            it("selects the drive from bit 0 of the control register", () => {
                const drive0 = makeOpus(OpusDoubleDensity);
                drive0.fdc.write(OpusCommandRegister, ForceInterrupt);
                expect(drive0.fdc.motorOn).toEqual([true, false]);

                const drive1 = makeOpus(OpusDoubleDensity | OpusDrive1);
                drive1.fdc.write(OpusCommandRegister, ForceInterrupt);
                expect(drive1.fdc.motorOn).toEqual([false, true]);
            });

            it.each([
                [OpusDoubleDensity, 2 * IbmDiscFormat.bytesPerTrack],
                [0, IbmDiscFormat.bytesPerTrack],
            ])("with control %i reads a revolution as %i bytes", (control, bytesPerRevolution) => {
                const { scheduler, fdc } = makeOpus(control, blankDisc());
                const { bytes } = runCommand(fdc, scheduler, ReadTrackCommand, {
                    commandRegister: OpusCommandRegister,
                    dataRegister: OpusDataRegister,
                });
                expect(bytes.length).toBeGreaterThan(bytesPerRevolution - 4);
                expect(bytes.length).toBeLessThanOrEqual(bytesPerRevolution + 4);
            });
        });
    });
});
