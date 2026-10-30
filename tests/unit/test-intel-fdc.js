import { describe, it, expect } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { IntelFdc } from "../../src/intel-fdc.js";
import { fake6502 } from "../../src/fake6502.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { findModel } from "../../src/models.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";
import { SectorBytes, appendFmSector, ms, ssdDisc } from "../helpers/disc-builders.js";

const AtomModel = findModel("Atom");

const WriteEnable = 0x01;
const ResetAddr = 2;

const StatusAddr = 0;
const ResultAddr = 1;
const DataAddr = 4;

const Busy = 0x80;
const CommandFull = 0x40;
const ParamFull = 0x20;
const ResultReady = 0x10;
const NeedData = 0x04;
const DriveNotReady = 0x10;
const TrackZeroNotFound = 0x14;
const SectorNotFound = 0x18;

const LoadHead = 0x08;
const DriveSelect1 = 0x40;
const DriveSelect2 = 0x80;

const WriteRegCmd = 0x3a;
const ReadSpecialRegisterCmd = 0x3d;
const ReadDriveStatusCmd = 0x2c;
const SpecifyCmd = 0x35;
const SeekCmd = (0x0a << 2) | DriveSelect1 | 1;
const ReadDataCmd = (0x04 << 2) | DriveSelect1 | 3;

const MmioWrite = 0x23;
const ModeRegister = 0x17;
const DfsMode = 0xc1;
const Initialisation = 0x0d;
const BadTracksDrive0 = 0x10;
const OneSectorOf256Bytes = 0x21;
// As DFS 1.20 specifies: the head stays loaded for 12 revolutions after a command.
const DfsHeadLoadUnload = 0xc8;
// What _stepRateMs takes for a step rate of 0.
const StepMs = 3;
const SectorsPerTrack = 10;
const Tracks = 80;
const PollTicks = 16;

class FakeDrive {
    constructor() {
        this.spinning = false;
        this.indexPulse = false;
        this.pulsesCallback = null;
        this.upperSide = false;
        this.track = 0;
        this.seeks = [];
    }
    selectSide(side) {
        this.upperSide = side;
    }
    setPulsesCallback(callback) {
        this.pulsesCallback = callback;
    }
    startSpinning() {
        this.spinning = true;
    }
    stopSpinning() {
        this.spinning = false;
    }
    seekOneTrack(dir) {
        this.track = this.track + dir;
    }
    notifySeekAmount(delta, stepMs) {
        this.seeks.push([delta, stepMs]);
    }
    notifySeekEnd() {
        this.seeks.push("end");
    }
    snapshotState() {
        return {};
    }
    restoreState() {}
}

/**
 * @param {IntelFdc} fdc
 * @param  {Number} command
 * @param  {...Number} params
 */
function sendCommand(fdc, command, ...params) {
    fdc.write(0, command);
    for (const param of params) fdc.write(1, param);
}

const realDrives = (count) => (scheduler, cpu) =>
    [...Array(count).keys()].map((id) => new DiscDrive(id, scheduler, cpu.peripheralCyclesPerSecond));

function makeFdc({ cpu = fake6502(), makeDrives = () => [new FakeDrive()] } = {}) {
    const scheduler = new Scheduler();
    const drives = makeDrives(scheduler, cpu);
    const fdc = new IntelFdc(cpu, scheduler, drives);
    return { cpu, fdc, scheduler, drives, drive: drives[0] };
}

const loadHeadOnDrive0 = (fdc) => sendCommand(fdc, WriteRegCmd, MmioWrite, LoadHead | DriveSelect1);

const specifyAsDfs = (fdc) => sendCommand(fdc, SpecifyCmd, Initialisation, 12, 10, DfsHeadLoadUnload);

// The defaults are DFS 1.20's: 24 ms steps, 20 ms settle, 64 ms head load.
function dfsFdc({
    stepRate = 12,
    settleTime = 10,
    headLoadUnload = DfsHeadLoadUnload,
    alterDisc = () => {},
    secondDisc,
} = {}) {
    const data = new Uint8Array(Tracks * SectorsPerTrack * SectorBytes);
    for (let track = 0; track < Tracks; ++track) data[track * SectorsPerTrack * SectorBytes] = track;
    const disc = ssdDisc(data);
    alterDisc(disc);
    const { fdc, scheduler, drive } = makeFdc({
        makeDrives: (scheduler, cpu) => {
            const drives = realDrives(secondDisc ? 2 : 1)(scheduler, cpu);
            drives[0].setDisc(disc);
            drives[1]?.setDisc(secondDisc);
            return drives;
        },
    });
    sendCommand(fdc, WriteRegCmd, ModeRegister, DfsMode);
    sendCommand(fdc, SpecifyCmd, Initialisation, stepRate, settleTime, headLoadUnload);
    sendCommand(fdc, SpecifyCmd, BadTracksDrive0, 0xff, 0xff, 0);
    loadHeadOnDrive0(fdc);
    scheduler.polltime(ms(1000));
    const readStatus = () => {
        sendCommand(fdc, ReadDriveStatusCmd | DriveSelect1);
        return fdc.read(ResultAddr);
    };
    readStatus();
    const readFirstByte = (track) => {
        sendCommand(fdc, ReadDataCmd, track, 0, OneSectorOf256Bytes);
        let firstByte = null;
        while (fdc.peek(StatusAddr) & Busy) {
            scheduler.polltime(PollTicks);
            if (fdc.peek(StatusAddr) & NeedData) {
                const byte = fdc.read(DataAddr);
                firstByte ??= byte;
            }
        }
        return { result: fdc.read(ResultAddr), firstByte };
    };
    return { fdc, scheduler, drive, readStatus, readFirstByte };
}

describe("Intel 8271 tests", function () {
    it("should construct and start out idle", () => {
        const { fdc, scheduler } = makeFdc();
        expect(fdc.read(StatusAddr)).toBe(0);
        expect(scheduler.headroom()).toBe(Scheduler.MaxHeadroom);
    });

    it("survives a reset with write enable up and the head unloaded", () => {
        const { fdc } = makeFdc();
        sendCommand(fdc, WriteRegCmd, MmioWrite, WriteEnable | DriveSelect1);
        expect(() => fdc.write(ResetAddr, 1)).not.toThrow();
    });

    it("should seek to a track", () => {
        const { fdc, scheduler, drive } = makeFdc();
        loadHeadOnDrive0(fdc);
        // nb will seek two more due to bad track nonsense
        sendCommand(fdc, SeekCmd, 2);
        expect(drive.track).toBe(1);
        expect(scheduler.headroom()).toBe(ms(StepMs));
        scheduler.polltime(ms(StepMs));
        expect(drive.track).toBe(2);
        scheduler.polltime(ms(10 * StepMs));
        expect(drive.track).toBe(4);
    });

    describe("seek noise", () => {
        it("announces the seek's tracks at the drive's own 3 ms when no rate was specified, and its end", () => {
            const { fdc, scheduler, drive } = makeFdc();
            loadHeadOnDrive0(fdc);
            sendCommand(fdc, SeekCmd, 2);
            expect(drive.seeks).toEqual([[4, 3]]);
            scheduler.polltime(ms(10 * StepMs));
            expect(drive.seeks).toEqual([[4, 3], "end"]);
        });

        it("announces the rate the DFS specified, doubled for a 5.25 inch drive", () => {
            const { fdc, drive } = makeFdc();
            specifyAsDfs(fdc);
            loadHeadOnDrive0(fdc);
            sendCommand(fdc, SeekCmd, 2);
            expect(drive.seeks).toEqual([[4, 24]]);
        });

        it("announces the steps its track register calls for, which the head takes wherever it is", () => {
            const { fdc, scheduler, drive } = makeFdc({ makeDrives: realDrives(1) });
            const events = [];
            drive.addEventListener("seekStart", (event) => events.push([event.steps, event.stepMs]));
            drive.addEventListener("seekEnd", (event) => events.push(`end after ${event.steps}`));
            sendCommand(fdc, SpecifyCmd, BadTracksDrive0, 0xff, 0xff, 0);
            loadHeadOnDrive0(fdc);
            sendCommand(fdc, SeekCmd, 13);
            scheduler.polltime(ms(20 * StepMs));
            expect(drive.track).toBe(13);
            for (let track = 13; track < 20; ++track) drive.seekOneTrack(1);
            events.length = 0;
            loadHeadOnDrive0(fdc);
            sendCommand(fdc, SeekCmd, 10);
            scheduler.polltime(ms(10 * StepMs));
            expect(events).toEqual([[-3, 3], "end after 3"]);
            expect(drive.track).toBe(17);
        });

        it("announces nothing for a seek to the track the head is on", () => {
            const { fdc, scheduler, drive } = makeFdc();
            loadHeadOnDrive0(fdc);
            sendCommand(fdc, SeekCmd, 2);
            scheduler.polltime(ms(10 * StepMs));
            drive.seeks.length = 0;
            sendCommand(fdc, SeekCmd, 2);
            scheduler.polltime(ms(10 * StepMs));
            expect(drive.seeks).toEqual([]);
        });
    });

    it("steps at the specified rate in milliseconds on the Atom's 1 MHz clock", () => {
        const { fdc, scheduler } = makeFdc({ cpu: fake6502(AtomModel) });
        specifyAsDfs(fdc);
        loadHeadOnDrive0(fdc);
        sendCommand(fdc, SeekCmd, 2);
        expect(scheduler.headroom()).toBe(24 * 1000);
    });

    it("loads the head over eight milliseconds a unit, as a 5.25 inch drive doubles it, after the steps", () => {
        const { fdc, scheduler, drive } = makeFdc();
        specifyAsDfs(fdc);
        sendCommand(fdc, WriteRegCmd, MmioWrite, DriveSelect1);
        sendCommand(fdc, SeekCmd, 1);
        // Three steps at the 24 ms the specify asked for, two extra for the bad track registers, sent
        // while LOAD HEAD gates the drive's select off, so they never reach it.
        let steps = 0;
        for (; scheduler.headroom() === ms(24); ++steps) scheduler.polltime(scheduler.headroom());
        expect([steps, drive.track]).toEqual([3, 0]);
        expect(scheduler.headroom()).toBe(ms(8 * 8));
    });

    describe("motor", () => {
        it("turns both drives while the head is loaded, and neither once it unloads", () => {
            const { fdc, drives } = makeFdc({ makeDrives: realDrives(2) });
            loadHeadOnDrive0(fdc);
            expect([drives[0].spinning, drives[1].spinning]).toEqual([true, true]);
            sendCommand(fdc, WriteRegCmd, MmioWrite, DriveSelect1);
            expect([drives[0].spinning, drives[1].spinning]).toEqual([false, false]);
        });

        it("lights only the selected drive", () => {
            const { fdc } = makeFdc({ makeDrives: realDrives(2) });
            loadHeadOnDrive0(fdc);
            expect(fdc.motorOn).toEqual([true, false]);
            sendCommand(fdc, WriteRegCmd, MmioWrite, LoadHead | DriveSelect2);
            expect(fdc.motorOn).toEqual([false, true]);
        });

        it("finds the newly selected drive already up to speed", () => {
            const { fdc, scheduler, drives } = makeFdc({ makeDrives: realDrives(2) });
            loadHeadOnDrive0(fdc);
            scheduler.polltime(ms(2000));
            sendCommand(fdc, WriteRegCmd, MmioWrite, LoadHead | DriveSelect2);
            expect(drives[1].speed).toBe(1);
        });
    });

    describe("seek to track 0", () => {
        const blankDiscDrive = (scheduler, cpu) => {
            const drives = realDrives(1)(scheduler, cpu);
            drives[0].setDisc(Disc.createBlank());
            return drives;
        };

        function seekToZeroFromTrack20(driveOut, { restoreMidSeek = false } = {}) {
            const { cpu, scheduler, drive: firstDrive, fdc: firstFdc } = makeFdc({ makeDrives: blankDiscDrive });
            let fdc = firstFdc;
            let drive = firstDrive;
            for (let step = 0; step < 20; ++step) drive.seekOneTrack(1);
            sendCommand(fdc, SpecifyCmd, Initialisation, 0, 0, DfsHeadLoadUnload);
            sendCommand(fdc, WriteRegCmd, MmioWrite, driveOut);
            scheduler.polltime(ms(1000));
            // The ready latch only updates when the drive status is read.
            sendCommand(fdc, ReadDriveStatusCmd | DriveSelect1);
            const start = scheduler.epoch;
            sendCommand(fdc, SeekCmd, 0);
            if (restoreMidSeek) {
                scheduler.polltime(ms(10 * StepMs));
                const snapshot = fdc.snapshotState();
                drive = new DiscDrive(0, scheduler, cpu.peripheralCyclesPerSecond);
                fdc = new IntelFdc(cpu, scheduler, [drive]);
                fdc.restoreState(snapshot);
            }
            while (fdc.peek(StatusAddr) & Busy) scheduler.polltime(ms(1));
            const steps = Math.round((scheduler.epoch - start) / ms(StepMs));
            return { result: fdc.read(ResultAddr), track: drive.track, steps };
        }

        it("with the head loaded first, as the DFS does, finds it", () => {
            expect(seekToZeroFromTrack20(LoadHead | DriveSelect1)).toMatchObject({ result: 0, track: 0 });
        });

        it("brings back a seek part way through from a snapshot", () => {
            const seeking = () => {
                const { fdc, scheduler } = makeFdc({ makeDrives: blankDiscDrive });
                return {
                    fdc,
                    scheduler,
                    snapshotState: () => fdc.snapshotState(),
                    restoreState: (state) => fdc.restoreState(state),
                };
            };
            return expectSnapshotRoundTrips(seeking, ({ fdc, scheduler }) => {
                sendCommand(fdc, SpecifyCmd, Initialisation, 0, 0, DfsHeadLoadUnload);
                loadHeadOnDrive0(fdc);
                sendCommand(fdc, SeekCmd, 40);
                scheduler.polltime(ms(10 * StepMs));
            });
        });

        it.each([false, true])(
            "with the head unloaded reaches no drive and gives up after 255 steps (restored mid-seek: %s)",
            (restoreMidSeek) =>
                expect(seekToZeroFromTrack20(DriveSelect1, { restoreMidSeek })).toEqual({
                    result: TrackZeroNotFound,
                    track: 20,
                    steps: 255,
                }),
        );
    });

    describe("ready", () => {
        function readyFdc({ cpu = fake6502(), indexHighAtSelection = false } = {}) {
            const { fdc, scheduler, drive } = makeFdc({ cpu });
            drive.indexPulse = indexHighAtSelection;
            // So that reading the status does not unload the head and deselect the drive.
            specifyAsDfs(fdc);
            loadHeadOnDrive0(fdc);
            const indexPulse = () => {
                drive.indexPulse = true;
                drive.pulsesCallback(0, 32);
                drive.indexPulse = false;
                drive.pulsesCallback(0, 32);
            };
            // The status is latched, so it takes two reads to see a change; the drive the
            // command byte's 0x40 selects reports as RDY0.
            const ready0 = 0x04;
            const ready = () => {
                sendCommand(fdc, ReadDriveStatusCmd | DriveSelect1);
                sendCommand(fdc, ReadDriveStatusCmd | DriveSelect1);
                return (fdc.read(ResultAddr) & ready0) === ready0;
            };
            const seek = () => {
                sendCommand(fdc, SeekCmd, 0);
                while (fdc.peek(StatusAddr) & Busy) scheduler.polltime(PollTicks);
                return fdc.read(ResultAddr);
            };
            return { fdc, scheduler, drive, indexPulse, ready, seek };
        }

        function stallAndResume({ scheduler, indexPulse }) {
            scheduler.polltime(ms(300));
            indexPulse();
            scheduler.polltime(ms(200));
            indexPulse();
        }

        function readyFdcAfterStatus() {
            const fixture = readyFdc();
            const { scheduler, indexPulse, ready } = fixture;
            indexPulse();
            scheduler.polltime(ms(200));
            indexPulse();
            expect(ready()).toBe(true);
            return fixture;
        }

        it("is latched off by an index pulse that finds it gone, until a read drive status", () => {
            const fixture = readyFdcAfterStatus();
            const { fdc, seek } = fixture;
            stallAndResume(fixture);
            expect(seek()).toBe(DriveNotReady);
            expect(seek()).toBe(DriveNotReady);
            sendCommand(fdc, ReadDriveStatusCmd | DriveSelect1);
            expect(seek()).toBe(0);
        });

        it("is not latched by index pulses during a seek, which the chip busy-waits through", () => {
            const fixture = readyFdcAfterStatus();
            const { fdc, scheduler, indexPulse } = fixture;
            sendCommand(fdc, SeekCmd, 79);
            stallAndResume(fixture);
            while (fdc.peek(StatusAddr) & Busy) {
                scheduler.polltime(ms(100));
                indexPulse();
            }
            expect(fdc.read(ResultAddr)).toBe(0);
        });

        it("comes on the second index pulse after selection, when they are coming in time", () => {
            const { scheduler, indexPulse, ready } = readyFdc();
            expect(ready()).toBe(false);
            indexPulse();
            expect(ready()).toBe(false);
            scheduler.polltime(ms(200));
            indexPulse();
            expect(ready()).toBe(true);
        });

        it("waits for pulses to come in time, and drops once they stop", () => {
            const { scheduler, indexPulse, ready } = readyFdc();
            indexPulse();
            scheduler.polltime(ms(300));
            indexPulse();
            expect(ready()).toBe(false);
            scheduler.polltime(ms(200));
            indexPulse();
            expect(ready()).toBe(true);
            scheduler.polltime(ms(300));
            indexPulse();
            expect(ready()).toBe(false);
        });

        it("drops after the same 262 ms on the Atom's 1 MHz clock", () => {
            const atomMs = (n) => n * 1000;
            const { scheduler, indexPulse, ready } = readyFdc({ cpu: fake6502(AtomModel) });
            indexPulse();
            scheduler.polltime(atomMs(200));
            indexPulse();
            expect(ready()).toBe(true);
            scheduler.polltime(atomMs(300));
            indexPulse();
            expect(ready()).toBe(false);
        });

        it("counts edges from the level the newly selected drive already shows", () => {
            const { scheduler, drive, indexPulse, ready } = readyFdc({ indexHighAtSelection: true });
            // Still high from before selection: not an edge.
            drive.pulsesCallback(0, 32);
            drive.indexPulse = false;
            drive.pulsesCallback(0, 32);
            for (const expected of [false, true]) {
                scheduler.polltime(ms(200));
                indexPulse();
                expect(ready()).toBe(expected);
            }
        });

        it("carries the latch through a snapshot, along with how stale its last pulse is", () => {
            const { fdc, scheduler, indexPulse, ready } = readyFdc();
            indexPulse();
            scheduler.polltime(ms(200));
            indexPulse();
            expect(ready()).toBe(true);

            const fresh = fdc.snapshotState();
            const { fdc: restoredFresh, ready: readyFresh } = readyFdc();
            restoredFresh.restoreState(fresh);
            expect(readyFresh()).toBe(true);

            // A pulse that comes after a long gap since the snapshot's last one drops the latch.
            const {
                fdc: restoredStale,
                scheduler: staleScheduler,
                indexPulse: stalePulse,
                ready: readyStale,
            } = readyFdc();
            restoredStale.restoreState(fresh);
            staleScheduler.polltime(ms(300));
            stalePulse();
            expect(readyStale()).toBe(false);
        });

        it("comes up ready from a snapshot made before the latch existed", () => {
            const { fdc, ready } = readyFdc();
            const state = fdc.snapshotState();
            delete state.ready;
            delete state.readyPulses;
            delete state.sinceIndexPulse;
            const { fdc: restored, ready: readyRestored } = readyFdc();
            restored.restoreState(state);
            expect(readyRestored()).toBe(true);
            expect(ready()).toBe(false);
        });

        it("goes once the pulses stop, before any pulse comes to say so", () => {
            const { scheduler, indexPulse, ready } = readyFdc();
            indexPulse();
            scheduler.polltime(ms(200));
            indexPulse();
            expect(ready()).toBe(true);
            scheduler.polltime(ms(300));
            expect(ready()).toBe(false);
        });

        it("outlives a stop and restart of the motor shorter than the timeout", () => {
            const { fdc, scheduler, indexPulse, ready } = readyFdc();
            indexPulse();
            scheduler.polltime(ms(200));
            indexPulse();
            // The command byte keeps the drive selected; only the motor stops.
            sendCommand(fdc, WriteRegCmd | DriveSelect1, MmioWrite, DriveSelect1);
            scheduler.polltime(ms(100));
            sendCommand(fdc, WriteRegCmd | DriveSelect1, MmioWrite, LoadHead | DriveSelect1);
            expect(ready()).toBe(true);
        });

        it("goes when the drive is deselected", () => {
            const { fdc, scheduler, indexPulse, ready } = readyFdc();
            indexPulse();
            scheduler.polltime(ms(200));
            indexPulse();
            expect(ready()).toBe(true);
            sendCommand(fdc, WriteRegCmd, MmioWrite, 0);
            loadHeadOnDrive0(fdc);
            expect(ready()).toBe(false);
        });
    });

    describe("head unload", () => {
        it("reads only the selected drive while the other turns", () => {
            const otherData = new Uint8Array(Tracks * SectorsPerTrack * SectorBytes).fill(0xaa);
            const secondDisc = loadSsd(new Disc(true, new DiscConfig(), "other.ssd"), otherData, false, null);
            const { readFirstByte } = dfsFdc({ secondDisc });
            expect(readFirstByte(5)).toEqual({ result: 0, firstByte: 5 });
        });

        it("does not unload the head in the middle of a seek longer than the unload count", () => {
            const { scheduler, readStatus, readFirstByte } = dfsFdc();
            expect(readFirstByte(79)).toEqual({ result: 0, firstByte: 79 });
            // 600 ms and 78 steps at 24 ms take the count a status read starts past 12 revolutions.
            readStatus();
            scheduler.polltime(ms(600));
            expect(readFirstByte(1)).toEqual({ result: 0, firstByte: 1 });
        });

        it("keeps the disc turning through the moment a write special register command deselects the drive", () => {
            const steady = dfsFdc();
            const rewritten = dfsFdc();
            for (let write = 0; write < 100; ++write) {
                loadHeadOnDrive0(rewritten.fdc);
                steady.scheduler.polltime(ms(1));
                rewritten.scheduler.polltime(ms(1));
            }
            expect(rewritten.drive.positionFraction).toBe(steady.drive.positionFraction);
        });

        /** One sector 0 on the physical track, its ID claiming another track, its first byte the physical one. */
        function buildTrackClaiming(disc, physicalTrack, claimedTrack) {
            const data = new Uint8Array(SectorBytes);
            data[0] = physicalTrack;
            appendFmSector(disc.buildTrack(false, physicalTrack), { track: claimedTrack, data }).fillFmByte(0xff);
        }

        it("does not count down a read's sector timeout during its seek to the next track after a mismatch", () => {
            // A 510 ms step and a 510 ms settle make the retry seek outlast three index pulses. The
            // head stays loaded throughout, so only the sector timeout can end the read.
            const neverUnload = 0xf8;
            const { readFirstByte } = dfsFdc({
                stepRate: 255,
                settleTime: 255,
                headLoadUnload: neverUnload,
                alterDisc: (disc) => {
                    buildTrackClaiming(disc, 5, 6);
                    buildTrackClaiming(disc, 6, 5);
                },
            });
            expect(readFirstByte(5)).toEqual({ result: 0, firstByte: 6 });
        });

        it("times out a read of a sector the track does not have after three revolutions", () => {
            const { fdc, scheduler } = dfsFdc();
            const missingSector = SectorsPerTrack;
            sendCommand(fdc, ReadDataCmd, 0, missingSector, OneSectorOf256Bytes);
            scheduler.polltime(ms(2 * 200));
            expect(fdc.peek(StatusAddr) & Busy).toBe(Busy);
            scheduler.polltime(ms(200));
            expect(fdc.peek(StatusAddr) & Busy).toBe(0);
            expect(fdc.read(ResultAddr)).toBe(SectorNotFound);
        });

        it("still unloads the head the counted revolutions after a command", () => {
            const { scheduler, drive, readFirstByte } = dfsFdc();
            readFirstByte(1);
            scheduler.polltime(ms(11 * 200));
            expect(drive.spinning).toBe(true);
            scheduler.polltime(ms(2 * 200));
            expect(drive.spinning).toBe(false);
        });
    });

    describe("peeking", () => {
        it("shows the data byte without lowering need-data, as reading it does, with the head already on the track", () => {
            const { fdc, scheduler, readFirstByte } = dfsFdc();
            readFirstByte(5);
            sendCommand(fdc, ReadDataCmd, 5, 0, OneSectorOf256Bytes);
            while (fdc.peek(StatusAddr) & Busy && !(fdc.peek(StatusAddr) & NeedData)) scheduler.polltime(PollTicks);
            expect(fdc.peek(StatusAddr) & NeedData).toBe(NeedData);
            expect(fdc.peek(DataAddr)).toBe(5);
            expect(fdc.peek(StatusAddr) & NeedData).toBe(NeedData);
            expect(fdc.read(DataAddr)).toBe(5);
            expect(fdc.peek(StatusAddr) & NeedData).toBe(0);
        });
    });

    describe("status register", () => {
        it("does not report command or parameter register full after the mode register is written", () => {
            const { fdc } = makeFdc();
            sendCommand(fdc, WriteRegCmd, ModeRegister, DfsMode);
            expect(fdc.read(StatusAddr)).toBe(0);
            sendCommand(fdc, ReadDriveStatusCmd);
            expect(fdc.read(StatusAddr)).toBe(ResultReady);
        });

        it("keeps the mode bits in the shared internal byte where read special register sees them", () => {
            const { fdc } = makeFdc();
            sendCommand(fdc, WriteRegCmd, ModeRegister, DfsMode);
            sendCommand(fdc, ReadSpecialRegisterCmd, ModeRegister);
            expect(fdc.read(ResultAddr)).toBe(DfsMode & ~CommandFull);
        });

        it("shows busy but not command register full once a command taking parameters is written", () => {
            const { fdc } = makeFdc();
            sendCommand(fdc, WriteRegCmd);
            expect(fdc.read(StatusAddr) & (Busy | CommandFull)).toBe(Busy);
        });

        it("does not report parameter register full after any parameter write", () => {
            const { fdc } = makeFdc();
            sendCommand(fdc, WriteRegCmd, ModeRegister);
            expect(fdc.read(StatusAddr) & (Busy | ParamFull)).toBe(Busy);
            sendCommand(fdc, WriteRegCmd, ModeRegister, DfsMode);
            expect(fdc.read(StatusAddr) & (Busy | ParamFull)).toBe(0);
        });
    });
});
