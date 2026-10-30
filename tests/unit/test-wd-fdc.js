import { describe, it, expect } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { WdFdc, WdFdcVariant } from "../../src/wd-fdc.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { IbmDiscFormat } from "../../src/disc-format.js";
import { fake6502 } from "../../src/fake6502.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";
import {
    MfmSectorGap,
    SectorBytes,
    SectorLengthCode,
    appendFmSector,
    appendMfmSector,
    blankDisc,
    fmDiscWithSector,
    mfmDiscWithSector,
    sectorData,
} from "../helpers/disc-builders.js";

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
const ControlRunningDrive1 = 0x22;
const ControlRunningNoDrive = 0x20;
const ControlResetDrive0 = 0x01;

const StatusBusy = 0x01;
const StatusDrq = 0x02;
const StatusLostData = 0x04;
const StatusCrcError = 0x08;
const StatusRecordNotFound = 0x10;
const StatusDeletedMark = 0x20;
const StatusWriteProtected = 0x40;

const ForceInterrupt = 0xd0;
// The whole low nibble, including the ready line bits the BBC can never exercise.
const AllFlagCombinations = [...Array(16).keys()];
// Type I, II and III commands with the spin-up wait disabled so they start without six
// revolutions of delay.
const RestoreCommand = 0x08;
const SeekCommand = 0x18;
const StepOutWithUpdateCommand = 0x78;
const ReadSectorCommand = 0x88;
const ReadAddressCommand = 0xc8;
const ReadTrackCommand = 0xe8;
// The e flag adds the head settle delay.
const SettleFlag = 0x04;
const VerifyFlag = 0x04;
const SpinUpWaitFlag = 0x08;

const TicksPerMs = 2000;
const RevolutionTicks = 200 * TicksPerMs;
// The step rate a command's rate bits of 00 select.
const StepTicks = 6 * TicksPerMs;
const RestoreGiveUpSteps = 255;
const DoneTimerTicks = 64;
// Long enough to reach the drive's first pulse callback and to outlast the 32us the controller
// takes to report a command as complete, but still well inside a seek's first step.
const ShortWaitTicks = 1000;
const MfmByteTicks = 64;
// Well inside the 32us an MFM byte takes, so no byte is lost between polls.
const PollTicks = 16;
// A type II command gives up after five revolutions, so a command still busy after ten has hung.
const MaxCommandTicks = 10 * RevolutionTicks;
// The motor times out after nine index pulses once the controller is idle.
const MotorTimeoutTicks = 10 * RevolutionTicks;

const IdMark = IbmDiscFormat.idMarkDataPattern;
const IndexMark = 0xfc;
const FmIndexMarkClocks = 0xd7;
const IndexMarkGap = 50;

function protectedDisc() {
    return new Disc(false, new DiscConfig(), "protected.ssd");
}

/**
 * A drive with no disc holds its index line permanently asserted, so the controller sees exactly
 * one index pulse edge: the first callback after the motor starts.
 *
 * @param {{disc?: Disc|null, control?: Number, controlRegister?: Number, variant?: WdFdcVariant}} [options]
 *   the disc in drive 0 if any, the first control register write and where it goes, and the
 *   controller variant
 */
function makeFdc({
    disc = null,
    control = ControlRunningDrive0,
    controlRegister = ControlRegister,
    variant = WdFdcVariant.wd1770,
} = {}) {
    const cpu = fake6502();
    const scheduler = new Scheduler();
    const drives = [
        new DiscDrive(0, scheduler, cpu.peripheralCyclesPerSecond),
        new DiscDrive(1, scheduler, cpu.peripheralCyclesPerSecond),
    ];
    if (disc) drives[0].setDisc(disc);
    const fdc = new WdFdc(cpu, scheduler, drives, variant);
    fdc.write(controlRegister, control);
    return { cpu, scheduler, fdc, drives };
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

// Runs whose MFM encoding contains the 0x00 then 0xc2 sync pattern at some bit offset.
const DataMimickingC2Sync = [0x01, 0xfe, 0x29, 0x07, 0xf8, 0xa4];

function appendMfmIndexMark(builder) {
    builder.appendRepeatMfmByte(0x4e, 60).appendRepeatMfmByte(0x00, 12);
    for (let i = 0; i < 3; ++i) builder.appendMfmPulses(IbmDiscFormat.mfmC2Sync);
    return builder.appendMfmByte(IndexMark).appendRepeatMfmByte(0x4e, IndexMarkGap);
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

        const seeking = () => {
            const machine = makeFdc({ disc: blankDisc() });
            machine.fdc.write(TrackRegister, 0);
            machine.fdc.write(DataRegister, 40);
            machine.fdc.write(CommandRegister, SeekCommand);
            machine.scheduler.polltime(ShortWaitTicks);
            return machine;
        };

        it("aborts a seek in progress and interrupts for &D8", () => {
            const { cpu, scheduler, fdc } = seeking();
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

        it.each([
            ["when idle", () => makeFdc()],
            ["during a seek", () => seeking()],
            ["when idle with no drive selected", () => makeFdc({ control: ControlRunningNoDrive })],
        ])("accepts every combination of flags %s", (_, setUp) => {
            for (const bits of AllFlagCombinations) {
                const { fdc } = setUp();
                expect(() => fdc.write(CommandRegister, ForceInterrupt | bits)).not.toThrow();
            }
        });
    });

    describe("with no drive selected", () => {
        it("aborts a command whose drive was deselected while it ran", () => {
            const { scheduler, fdc } = makeFdc({ disc: blankDisc() });
            fdc.write(CommandRegister, ReadSectorCommand);
            scheduler.polltime(ShortWaitTicks);
            fdc.write(ControlRegister, ControlRunningNoDrive);
            fdc.write(CommandRegister, ForceInterrupt);
            scheduler.polltime(ShortWaitTicks);
            expect(fdc.read(StatusRegister) & StatusBusy).toBe(0);
        });

        it("aborts a command issued with no drive selected, which waits for index pulses that never come", () => {
            const { scheduler, fdc } = makeFdc({ control: ControlRunningNoDrive });
            fdc.write(CommandRegister, ReadSectorCommand);
            scheduler.polltime(MaxCommandTicks);
            expect(fdc.read(StatusRegister) & StatusBusy).toBe(StatusBusy);
            fdc.write(CommandRegister, ForceInterrupt);
            scheduler.polltime(ShortWaitTicks);
            expect(fdc.read(StatusRegister) & StatusBusy).toBe(0);
        });

        it.each([
            ["without", 0, 0],
            ["with", VerifyFlag, StatusRecordNotFound],
        ])("gives up a restore %s verify after 255 steps with no drive selected", (_, verify, seekError) => {
            const { scheduler, fdc } = makeFdc({ control: ControlRunningNoDrive });
            const { status, ticks } = runCommand(fdc, scheduler, RestoreCommand | verify);
            expect(status & StatusRecordNotFound).toBe(seekError);
            expect(Math.round(ticks / StepTicks)).toBe(RestoreGiveUpSteps);
        });
    });

    describe("peeking", () => {
        it("shows the status without clearing the interrupt, as reading it does", () => {
            const { cpu, fdc } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt | 0x08);
            const status = fdc.peek(StatusRegister);
            expect(cpu.nmi).toBe(true);
            expect(fdc.read(StatusRegister)).toBe(status);
            expect(cpu.nmi).toBe(false);
        });

        it("shows a sector's data byte without dropping DRQ, as reading it does", () => {
            const data = sectorData();
            const { scheduler, fdc } = makeFdc({ disc: mfmDiscWithSector({ data }) });
            fdc.write(SectorRegister, 0);
            fdc.write(CommandRegister, ReadSectorCommand);
            for (
                let ticks = 0;
                !(fdc.peek(StatusRegister) & StatusDrq) && ticks < MaxCommandTicks;
                ticks += PollTicks
            ) {
                scheduler.polltime(PollTicks);
            }
            expect(fdc.peek(StatusRegister) & StatusDrq).toBe(StatusDrq);
            expect(fdc.peek(DataRegister)).toBe(data[0]);
            expect(fdc.peek(StatusRegister) & StatusDrq).toBe(StatusDrq);
            expect(fdc.read(DataRegister)).toBe(data[0]);
            expect(fdc.peek(StatusRegister) & StatusDrq).toBe(0);
        });
    });

    describe("seek noise", () => {
        /** What the drive is told: each seek's tracks and rate, and "end" when the head stops. */
        const seekNoises = (drive) => {
            const events = [];
            drive.addEventListener("seekStart", (event) => events.push([event.steps, event.stepMs]));
            drive.addEventListener("seekEnd", (event) => events.push(`end after ${event.steps}`));
            return events;
        };
        const StepRate12ms = 0x01;
        const StepInCommand = 0x48;
        const StepOutCommand = 0x68;

        it.each([
            {
                name: "the difference between the track asked for and the track register, at the command's rate, ending when the head stops",
                trackRegister: 5,
                dataRegister: 35,
                command: SeekCommand | StepRate12ms,
                events: [[30, 12], "end after 30"],
                finalTrack: 30,
            },
            {
                name: "nothing for a seek outwards with the head already at track 0",
                trackRegister: 5,
                dataRegister: 0,
                command: SeekCommand,
                events: [],
                finalTrack: 0,
            },
            {
                name: "the distance the head steps out on a restore, whatever the track register says",
                headTrack: 20,
                trackRegister: 3,
                command: RestoreCommand,
                events: [[-20, 6], "end after 20"],
                finalTrack: 0,
            },
            {
                name: "one track for a step command, ending when it has stepped",
                command: StepInCommand,
                events: [[1, 6], "end after 1"],
                finalTrack: 1,
            },
            {
                name: "the step out from track 1 onto the edge, counted before the head has moved",
                headTrack: 1,
                command: StepOutCommand,
                events: [[-1, 6], "end after 1"],
                finalTrack: 0,
            },
        ])("is $name", ({ headTrack = 0, trackRegister, dataRegister, command, events, finalTrack }) => {
            const { scheduler, fdc, drives } = makeFdc({ disc: blankDisc() });
            for (let track = 0; track < headTrack; ++track) drives[0].seekOneTrack(1);
            const seen = seekNoises(drives[0]);
            if (trackRegister !== undefined) fdc.write(TrackRegister, trackRegister);
            if (dataRegister !== undefined) fdc.write(DataRegister, dataRegister);
            runCommand(fdc, scheduler, command);
            expect(seen).toEqual(events);
            expect(drives[0].track).toBe(finalTrack);
        });
    });

    describe("control register", () => {
        it("leaves the disc turning undisturbed when rewritten with the same drive and side", () => {
            const running = () => {
                const { fdc, scheduler, drives } = makeFdc({ disc: mfmDiscWithSector({}) });
                runCommand(fdc, scheduler, RestoreCommand);
                return { fdc, scheduler, drive: drives[0] };
            };
            const steady = running();
            const rewritten = running();
            for (let write = 0; write < 100; ++write) {
                rewritten.fdc.write(ControlRegister, ControlRunningDrive0);
                steady.scheduler.polltime(ShortWaitTicks);
                rewritten.scheduler.polltime(ShortWaitTicks);
            }
            expect(rewritten.drive.positionFraction).toBe(steady.drive.positionFraction);
        });

        describe("written mid-command", () => {
            const SeekTarget = 40;
            const StepsBeforeWrite = 10;

            const runUntilIdle = (fdc, scheduler) => {
                const start = scheduler.epoch;
                while (fdc.read(StatusRegister) & StatusBusy) {
                    scheduler.polltime(ShortWaitTicks);
                    if (scheduler.epoch - start > MaxCommandTicks) throw new Error("Command never finished");
                }
            };

            const seekThenWriteControl = (control) => {
                const { scheduler, fdc, drives } = makeFdc({ disc: blankDisc() });
                drives[1].setDisc(blankDisc());
                const noises = [];
                drives[0].addEventListener("seekStart", (event) => noises.push(event.steps));
                drives[0].addEventListener("seekEnd", (event) => noises.push(`end after ${event.steps}`));
                fdc.write(TrackRegister, 0);
                fdc.write(DataRegister, SeekTarget);
                fdc.write(CommandRegister, SeekCommand);
                scheduler.polltime(StepsBeforeWrite * StepTicks - ShortWaitTicks);
                fdc.write(ControlRegister, control);
                runUntilIdle(fdc, scheduler);
                return { fdc, drives, noises };
            };

            it("steps the newly selected drive for the rest of the seek", () => {
                const { fdc, drives } = seekThenWriteControl(ControlRunningDrive1);
                expect(fdc.read(TrackRegister)).toBe(SeekTarget);
                expect([drives[0].track, drives[1].track]).toEqual([StepsBeforeWrite, SeekTarget - StepsBeforeWrite]);
                expect([drives[0].spinning, drives[1].spinning]).toEqual([true, true]);
            });

            it("finishes the seek with no drive selected", () => {
                const { fdc, drives } = seekThenWriteControl(ControlRunningNoDrive);
                expect(fdc.read(TrackRegister)).toBe(SeekTarget);
                expect(drives[0].track).toBe(StepsBeforeWrite);
            });

            it("ends the deselected drive's seek noise at the steps it took", () => {
                const { noises } = seekThenWriteControl(ControlRunningNoDrive);
                expect(noises).toEqual([SeekTarget, `end after ${StepsBeforeWrite}`]);
            });

            it("reads the newly selected drive's sector", () => {
                const { scheduler, fdc, drives } = makeFdc({ disc: blankDisc() });
                drives[1].setDisc(mfmDiscWithSector({}));
                fdc.write(CommandRegister, ReadAddressCommand);
                scheduler.polltime(ShortWaitTicks);
                fdc.write(ControlRegister, ControlRunningDrive1);
                const bytes = [];
                const start = scheduler.epoch;
                while (fdc.read(StatusRegister) & StatusBusy && scheduler.epoch - start < MaxCommandTicks) {
                    if (fdc.read(StatusRegister) & StatusDrq) bytes.push(fdc.read(DataRegister));
                    scheduler.polltime(PollTicks);
                }
                expect(bytes.slice(0, 4)).toEqual([0, 0, 0, SectorLengthCode]);
                expect(fdc.read(StatusRegister) & StatusRecordNotFound).toBe(0);
            });

            it("leaves the seek and its noise alone when rewritten with the same drive", () => {
                const { fdc, drives, noises } = seekThenWriteControl(ControlRunningDrive0);
                expect(fdc.read(TrackRegister)).toBe(SeekTarget);
                expect(drives[0].track).toBe(SeekTarget);
                expect(noises).toEqual([SeekTarget, `end after ${SeekTarget}`]);
            });

            it("counts the newly selected drive's index pulses", () => {
                // Drive 0 has no disc, so its index never ends and the read would never give up.
                const { scheduler, fdc, drives } = makeFdc();
                drives[1].setDisc(blankDisc());
                fdc.write(CommandRegister, ReadAddressCommand);
                scheduler.polltime(ShortWaitTicks);
                fdc.write(ControlRegister, ControlRunningDrive1);
                runUntilIdle(fdc, scheduler);
                expect(fdc.read(StatusRegister) & StatusRecordNotFound).toBe(StatusRecordNotFound);
            });

            it("waits for a disc with no drive selected", () => {
                const { scheduler, fdc } = makeFdc({ disc: mfmDiscWithSector({}) });
                fdc.write(CommandRegister, ReadSectorCommand | SettleFlag);
                fdc.write(ControlRegister, ControlRunningNoDrive);
                scheduler.polltime(MaxCommandTicks);
                expect(fdc.read(StatusRegister) & StatusBusy).toBe(StatusBusy);
            });
        });
    });

    describe("motor", () => {
        it("turns the unselected drive at the same speed as the selected one", () => {
            const { scheduler, fdc, drives } = makeFdc({ disc: blankDisc() });
            runCommand(fdc, scheduler, RestoreCommand);
            scheduler.polltime(RevolutionTicks);
            expect(drives[1].spinning).toBe(true);
            expect(drives[1].speed).toBe(drives[0].speed);
        });

        it("keeps turning both drives across a change of drive", () => {
            const { scheduler, fdc, drives } = makeFdc({ disc: blankDisc() });
            runCommand(fdc, scheduler, RestoreCommand);
            fdc.write(ControlRegister, ControlRunningDrive1);
            expect([drives[0].spinning, drives[1].spinning]).toEqual([true, true]);
        });

        it("stops both drives when the motor times out", () => {
            const { scheduler, fdc, drives } = makeFdc({ disc: blankDisc() });
            runCommand(fdc, scheduler, RestoreCommand);
            scheduler.polltime(MotorTimeoutTicks);
            expect([drives[0].spinning, drives[1].spinning]).toEqual([false, false]);
        });

        it("stops both drives on a reset", () => {
            const { scheduler, fdc, drives } = makeFdc({ disc: blankDisc() });
            runCommand(fdc, scheduler, RestoreCommand);
            fdc.write(ControlRegister, ControlResetDrive0);
            expect([drives[0].spinning, drives[1].spinning]).toEqual([false, false]);
        });

        it("starts both drives for a force interrupt while idle", () => {
            const { fdc, drives } = makeFdc();
            fdc.write(CommandRegister, ForceInterrupt);
            expect([drives[0].spinning, drives[1].spinning]).toEqual([true, true]);
        });

        it("lights only the selected drive", () => {
            const { scheduler, fdc } = makeFdc({ disc: blankDisc() });
            runCommand(fdc, scheduler, RestoreCommand);
            expect(fdc.motorOn).toEqual([true, false]);
            fdc.write(ControlRegister, ControlRunningDrive1);
            expect(fdc.motorOn).toEqual([false, true]);
        });

        const snapshotting = (options) => () => {
            const rig = makeFdc(options());
            return Object.assign(rig, {
                snapshotState: () => rig.fdc.snapshotState(),
                restoreState: (state) => rig.fdc.restoreState(state),
            });
        };

        it("brings back a sector read part way through from a snapshot that JSON can carry", async () => {
            const reading = snapshotting(() => ({ disc: mfmDiscWithSector({ data: sectorData() }) }));
            const pollUntil = ({ fdc, scheduler }, done) => {
                const start = scheduler.epoch;
                while (!done()) {
                    if (fdc.read(CommandRegister) & StatusDrq) fdc.read(DataRegister);
                    scheduler.polltime(PollTicks);
                    if (scheduler.epoch - start > MaxCommandTicks) throw new Error("The read never got there");
                }
            };
            let saved;
            await expectSnapshotRoundTrips(reading, (rig) => {
                rig.fdc.write(SectorRegister, 0);
                rig.fdc.write(CommandRegister, ReadSectorCommand);
                pollUntil(rig, () => rig.fdc.read(CommandRegister) & StatusDrq);
                saved = rig.fdc.snapshotState();
            });

            const restored = reading();
            restored.fdc.restoreState(JSON.parse(JSON.stringify(saved)));
            expect(restored.fdc.read(CommandRegister) & StatusBusy).toBe(StatusBusy);
            pollUntil(restored, () => !(restored.fdc.read(CommandRegister) & StatusBusy));
            expect(restored.fdc.read(CommandRegister) & (StatusRecordNotFound | StatusCrcError)).toBe(0);
        });

        it("brings back its registers from a snapshot with no drive selected", () =>
            expectSnapshotRoundTrips(
                snapshotting(() => ({ control: ControlRunningNoDrive })),
                ({ fdc }) => {
                    fdc.write(TrackRegister, 42);
                    fdc.write(SectorRegister, 7);
                },
            ));

        it("turns both drives after restoring a snapshot in which only the selected one turned", () => {
            const original = makeFdc({ disc: blankDisc() });
            runCommand(original.fdc, original.scheduler, RestoreCommand);
            const snapshot = original.fdc.snapshotState();
            snapshot.drives[1] = { ...snapshot.drives[1], spinning: false, timerTaskOffset: null };
            const { fdc, drives } = makeFdc({ disc: blankDisc() });
            fdc.restoreState(snapshot);
            expect([drives[0].spinning, drives[1].spinning]).toEqual([true, true]);
        });

        it("reads only the selected drive", () => {
            const data = sectorData();
            const { scheduler, fdc, drives } = makeFdc({ disc: mfmDiscWithSector({ data }) });
            drives[1].setDisc(mfmDiscWithSector({ data: new Uint8Array(SectorBytes).fill(0xaa) }));
            fdc.write(SectorRegister, 0);
            const { bytes, status } = runCommand(fdc, scheduler, ReadSectorCommand);
            expect(status & (StatusRecordNotFound | StatusCrcError)).toBe(0);
            expect(hex(bytes)).toBe(hex([...data]));
        });

        it("keeps both drives turning with no drive selected, as no index pulses come to time it out", () => {
            const { scheduler, fdc, drives } = makeFdc({ disc: blankDisc() });
            runCommand(fdc, scheduler, RestoreCommand);
            fdc.write(ControlRegister, ControlRunningNoDrive);
            scheduler.polltime(MotorTimeoutTicks);
            expect([drives[0].spinning, drives[1].spinning]).toEqual([true, true]);
        });
    });

    describe("write protect", () => {
        it.each([
            ["a protected disc", "restore", protectedDisc, RestoreCommand, StatusWriteProtected],
            ["a protected disc", "seek", protectedDisc, SeekCommand, StatusWriteProtected],
            ["a protected disc", "step", protectedDisc, StepOutWithUpdateCommand, StatusWriteProtected],
            ["a writable disc as unprotected", "restore", blankDisc, RestoreCommand, 0],
        ])("shows %s in the status after a %s", (_, __, disc, command, expected) => {
            const { scheduler, fdc } = makeFdc({ disc: disc() });
            const { status } = runCommand(fdc, scheduler, command);
            expect(status & StatusWriteProtected).toBe(expected);
        });

        it.each([
            ["writable to protected", blankDisc, protectedDisc, StatusWriteProtected],
            ["protected to writable", protectedDisc, blankDisc, 0],
        ])("follows a disc changed from %s after a type I command", (_, before, after, expected) => {
            const { scheduler, fdc, drives } = makeFdc({ disc: before() });
            runCommand(fdc, scheduler, RestoreCommand);
            drives[0].setDisc(after());
            scheduler.polltime(RevolutionTicks);
            expect(fdc.read(StatusRegister) & StatusWriteProtected).toBe(expected);
        });

        it("clears with track 0 and the index when the motor times out", () => {
            const { scheduler, fdc } = makeFdc({ disc: protectedDisc() });
            const { status } = runCommand(fdc, scheduler, RestoreCommand);
            expect(status & StatusWriteProtected).toBe(StatusWriteProtected);
            scheduler.polltime(MotorTimeoutTicks);
            expect(fdc.read(StatusRegister) & StatusWriteProtected).toBe(0);
        });

        it("shows a protected disc after a force interrupt while idle", () => {
            const { scheduler, fdc } = makeFdc({ disc: protectedDisc() });
            runCommand(fdc, scheduler, ReadAddressCommand);
            fdc.write(CommandRegister, ForceInterrupt);
            scheduler.polltime(RevolutionTicks);
            expect(fdc.read(StatusRegister) & StatusWriteProtected).toBe(StatusWriteProtected);
        });

        it("does not show a protected disc after a read", () => {
            const { scheduler, fdc } = makeFdc({ disc: protectedDisc() });
            const { status } = runCommand(fdc, scheduler, ReadAddressCommand);
            expect(status & StatusWriteProtected).toBe(0);
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
            expect(hex(bytes)).toContain(`c2c2c2fc${"4e".repeat(IndexMarkGap + MfmSectorGap)}0000`);
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

    describe("an SSD's track skew", () => {
        it("reaches the next track's first sector well within a revolution of this track's last", () => {
            const SsdSectorsPerTrack = 10;
            const disc = loadSsd(blankDisc(), new Uint8Array(2 * SsdSectorsPerTrack * SectorBytes), false, null);
            const { scheduler, fdc } = makeFdc({ disc, control: ControlRunningDrive0Fm });
            fdc.write(SectorRegister, SsdSectorsPerTrack - 1);
            runCommand(fdc, scheduler, ReadSectorCommand & ~SpinUpWaitFlag);

            const start = scheduler.epoch;
            fdc.write(DataRegister, 1);
            runCommand(fdc, scheduler, SeekCommand);
            fdc.write(SectorRegister, 0);
            const { status } = runCommand(fdc, scheduler, ReadSectorCommand | SettleFlag);

            expect(status & StatusRecordNotFound).toBe(0);
            expect(scheduler.epoch - start).toBeLessThan(RevolutionTicks / 2);
        });
    });

    describe("variants", () => {
        describe("step rate", () => {
            it.each([
                [WdFdcVariant.wd1770, 0, 6],
                [WdFdcVariant.wd1770, 1, 12],
                [WdFdcVariant.wd1770, 2, 20],
                [WdFdcVariant.wd1770, 3, 30],
                [WdFdcVariant.wd1772, 0, 6],
                [WdFdcVariant.wd1772, 1, 12],
                [WdFdcVariant.wd1772, 2, 2],
                [WdFdcVariant.wd1772, 3, 3],
            ])("a %s steps one track at rate %i in %i ms", (variant, rate, ms) => {
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

            // Every record is sector 0, so a read sector shows the settle delay to within one record.
            const RecordDataBytes = 128;
            const RecordLengthCode = 0;
            const RecordTicks = 212 * MfmByteTicks;
            function discOfRecords() {
                const disc = blankDisc();
                const builder = disc.buildTrack(false, 0);
                for (let record = 0; record < 25; ++record) {
                    appendMfmSector(builder, { lengthCode: RecordLengthCode, data: new Uint8Array(RecordDataBytes) });
                }
                builder.fillMfmByte(0x4e);
                return disc;
            }

            const ReadSectorSpinningUp = ReadSectorCommand & ~SpinUpWaitFlag;
            const ReadAddressSpinningUp = ReadAddressCommand & ~SpinUpWaitFlag;
            const MotorStopped = "stopped";
            const MotorRunning = "already running";

            function commandTicks({ variant = WdFdcVariant.wd1770, disc, motor, command }) {
                const { scheduler, fdc } = makeFdc({ disc: disc(), variant });
                fdc.write(SectorRegister, 0);
                if (motor === MotorRunning) runCommand(fdc, scheduler, ReadAddressSpinningUp);
                return runCommand(fdc, scheduler, command).ticks;
            }

            function settleDelay(setup) {
                return commandTicks({ ...setup, command: setup.command | SettleFlag }) - commandTicks(setup);
            }

            describe.each([
                ["read sector", ReadSectorSpinningUp, discOfRecords, RecordTicks],
                ["read address", ReadAddressSpinningUp, discOfIds, IdTicks],
            ])("a %s", (_, command, disc, tolerance) => {
                it.each([[MotorStopped], [MotorRunning]])("waits 30 ms for the e flag with the motor %s", (motor) => {
                    const delay = settleDelay({ disc, motor, command });
                    expect(delay).toBeGreaterThan(30 * TicksPerMs - tolerance);
                    expect(delay).toBeLessThan(30 * TicksPerMs + tolerance);
                });
            });

            it("a read address with the spin-up wait disabled still waits for the e flag", () => {
                // The disc is still coming up to speed, so the wait does not add a fixed time.
                const setup = { disc: discOfIds, motor: MotorStopped, command: ReadAddressCommand };
                const ticks = commandTicks({ ...setup, command: ReadAddressCommand | SettleFlag });
                expect(ticks).toBeGreaterThan(30 * TicksPerMs);
                expect(ticks).toBeGreaterThan(commandTicks(setup));
            });

            it("a read sector without the e flag does not wait", () => {
                const ticks = commandTicks({ disc: discOfRecords, motor: MotorRunning, command: ReadSectorCommand });
                expect(ticks).toBeLessThan(2 * RecordTicks + DoneTimerTicks + PollTicks);
            });

            it("a 1772 waits 15 ms for the e flag", () => {
                const delay = settleDelay({
                    variant: WdFdcVariant.wd1772,
                    disc: discOfIds,
                    motor: MotorStopped,
                    command: ReadAddressSpinningUp,
                });
                expect(delay).toBeGreaterThan(15 * TicksPerMs - IdTicks);
                expect(delay).toBeLessThan(15 * TicksPerMs + IdTicks);
            });

            describe("a type I verify", () => {
                function toTrack0Ticks({ variant, fromTrack, command }) {
                    const { scheduler, fdc } = makeFdc({ disc: discOfIds(), variant });
                    runCommand(fdc, scheduler, ReadAddressSpinningUp);
                    fdc.write(TrackRegister, 0);
                    fdc.write(DataRegister, fromTrack);
                    runCommand(fdc, scheduler, SeekCommand);
                    fdc.write(DataRegister, 0);
                    return runCommand(fdc, scheduler, command).ticks;
                }

                describe.each([
                    ["seek", 1, SeekCommand],
                    ["seek", 0, SeekCommand],
                    ["step out", 1, StepOutWithUpdateCommand],
                    ["restore", 1, RestoreCommand],
                ])("a %s from track %i", (_, fromTrack, command) => {
                    it.each([
                        [WdFdcVariant.wd1770, 30],
                        [WdFdcVariant.wd1772, 15],
                    ])("on a %s waits %i ms before verifying", (variant, ms) => {
                        const setup = { variant, fromTrack };
                        const delay =
                            toTrack0Ticks({ ...setup, command: command | VerifyFlag }) -
                            toTrack0Ticks({ ...setup, command });
                        expect(delay).toBeGreaterThan(ms * TicksPerMs);
                        expect(delay).toBeLessThan(ms * TicksPerMs + 2 * IdTicks);
                    });
                });
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
                return makeFdc({
                    disc,
                    control,
                    controlRegister: OpusControlRegister,
                    variant: WdFdcVariant.opusChallenger,
                });
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
