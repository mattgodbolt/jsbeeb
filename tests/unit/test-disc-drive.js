import { afterEach, describe, it, expect, vi } from "vitest";

import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { IbmDiscFormat } from "../../src/disc-format.js";
import { attachDriveNoise, DiscDrive } from "../../src/disc-drive.js";
import { Scheduler } from "../../src/scheduler.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";

const SectorsPerTrack = 10;
const SectorSize = 256;
const BbcCyclesPerSecond = 2 * 1000 * 1000;
const AtomCyclesPerSecond = 1000 * 1000;

function ssdDisc(numTracks, is40Track) {
    const config = new DiscConfig();
    config.expandTo80 = is40Track;
    const data = new Uint8Array(numTracks * SectorsPerTrack * SectorSize).fill(0x55);
    return loadSsd(new Disc(true, config, "test.ssd"), data, false, null);
}

const eightyTrackDisc = () => ssdDisc(80, false);
const fortyTrackDisc = () => ssdDisc(40, true);

const ms = (n) => n * 2000;

function spinningDrive(cyclesPerSecond = BbcCyclesPerSecond) {
    const scheduler = new Scheduler();
    const drive = new DiscDrive(0, scheduler, cyclesPerSecond);
    drive.setDisc(fortyTrackDisc());
    drive.startSpinning();
    return { scheduler, drive };
}

describe("Disc drive tests", function () {
    it("starts empty, asserting index all the time", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler, BbcCyclesPerSecond);
        expect(drive.trackLength).toBe(IbmDiscFormat.bytesPerTrack);
        expect(drive.disc).toBeFalsy();
        expect(drive.spinning).toBe(false);
        expect(drive.indexPulse).toBe(true);
        drive.setPulsesCallback(() => {
            expect.fail("no callbacks expected");
        });
        scheduler.polltime(1000000);
    });
    it("calls back with pulses after spinning starts", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler, BbcCyclesPerSecond);
        drive.setDisc(Disc.createBlank());
        drive.setPulsesCallback(() => {
            expect.fail("no callbacks expected");
        });
        scheduler.polltime(1000000);
        drive.startSpinning();
        drive.setPulsesCallback(() => {});
        scheduler.polltime(3 * 2000000);
        let numPulses = 0;
        drive.setPulsesCallback(() => numPulses++);
        scheduler.polltime(500);
        expect(numPulses).toBe(4);
        drive.stopSpinning();
        drive.setPulsesCallback(() => {
            expect.fail("no callbacks expected");
        });
        scheduler.polltime(1000000);
    });
    it("reads a blank disc as quasi random pulses the FM decoder takes for clean data that changes over time", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler, BbcCyclesPerSecond);
        drive.setDisc(Disc.createBlank());
        const decoded = [];
        drive.setPulsesCallback((pulses, numPulses) => {
            expect(numPulses).toBe(32);
            decoded.push(IbmDiscFormat._2usPulsesToFm(pulses));
        });
        drive.startSpinning();
        scheduler.polltime(ms(10));
        expect(decoded.length).toBeGreaterThan(0);
        for (const fm of decoded) expect(fm).toMatchObject({ clocks: 0xff, iffyPulses: false });
        expect(new Set(decoded.map((fm) => fm.data)).size).toBeGreaterThan(1);
    });

    it("asserts index periodically with a spinning disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler, BbcCyclesPerSecond);
        drive.setDisc(Disc.createBlank());
        drive.startSpinning();
        scheduler.polltime(3 * BbcCyclesPerSecond);
        let previousIndex = drive.indexPulse;
        let risingEdges = 0;
        const cyclesPerIter = BbcCyclesPerSecond / 60;
        const rpm = 300;
        const testSeconds = 5;
        for (let cycle = 0; cycle < testSeconds * BbcCyclesPerSecond; cycle += cyclesPerIter) {
            scheduler.polltime(cyclesPerIter);
            if (drive.indexPulse && !previousIndex) risingEdges++;
            previousIndex = drive.indexPulse;
        }
        expect(risingEdges).toBe((rpm / 60) * testSeconds);
    });
    it("keeps the index coming after a disc with shorter tracks goes in past the end of them", () => {
        const ShortTrackLength = IbmDiscFormat.bytesPerTrack / 4;
        const shortDisc = Disc.createBlank();
        shortDisc.buildTrack(false, 0).appendRepeatFmByte(0xff, ShortTrackLength).setTrackLength();
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler, BbcCyclesPerSecond);
        drive.setDisc(Disc.createBlank());
        drive.startSpinning();
        scheduler.polltime(3 * BbcCyclesPerSecond);
        drive.positionFraction = 0.9;
        drive.setDisc(shortDisc);
        expect(drive.positionFraction).toBeCloseTo(0.9, 2);
        let risingEdges = 0;
        let previousIndex = drive.indexPulse;
        const cyclesPerIter = 100;
        for (let cycle = 0; cycle < BbcCyclesPerSecond / 2; cycle += cyclesPerIter) {
            scheduler.polltime(cyclesPerIter);
            if (drive.indexPulse && !previousIndex) risingEdges++;
            previousIndex = drive.indexPulse;
        }
        // Half a second from 0.9 of the way round passes the index at 0.02, 0.22 and 0.42 s.
        expect(risingEdges).toBe(3);
    });
});

describe("40 track discs", () => {
    afterEach(() => vi.restoreAllMocks());

    /** @returns {DiscDrive} a drive with its 40/80 switch at 40, stepped `steps` times inwards. */
    function driveSteppedIn(disc, steps) {
        const drive = new DiscDrive(0, new Scheduler(), BbcCyclesPerSecond);
        drive.setDisc(disc);
        drive.tracksPerStep = 2;
        for (let step = 0; step < steps; ++step) drive.seekOneTrack(1);
        return drive;
    }

    it("double steps with its switch at 40", () => {
        const drive = driveSteppedIn(fortyTrackDisc(), 2);

        expect(drive.track).toBe(4);
    });

    it("single steps with its switch at 80", () => {
        const drive = new DiscDrive(0, new Scheduler(), BbcCyclesPerSecond);
        drive.setDisc(fortyTrackDisc());

        drive.seekOneTrack(1);

        expect(drive.track).toBe(1);
    });

    it("stops on the outermost track double stepping can reach", () => {
        vi.spyOn(globalThis.console, "log").mockImplementation(() => {});
        const drive = driveSteppedIn(fortyTrackDisc(), IbmDiscFormat.tracksPerDisc);

        expect(drive.track).toBe(IbmDiscFormat.tracksPerDisc - 2);
    });

    it("wipes the track its head also covers", () => {
        // An 80 track disc formatted by a drive set to 40: every other track is left with nothing.
        const disc = eightyTrackDisc();
        const drive = driveSteppedIn(disc, 1);
        expect(disc.getTrack(false, 3).findSectors()).toHaveLength(10);
        drive.writePulses(0x12345678);

        drive.seekOneTrack(1);

        expect(disc.readPulses(false, 2, 0)).toBe(0x12345678);
        expect(disc.getTrack(false, 3).findSectors()).toEqual([]);
    });

    it("leaves the neighbouring track alone with its switch at 80", () => {
        const disc = eightyTrackDisc();
        const drive = new DiscDrive(0, new Scheduler(), BbcCyclesPerSecond);
        drive.setDisc(disc);
        drive.seekOneTrack(1);
        drive.seekOneTrack(1);
        const neighbour = disc.readPulses(false, 3, 0);
        drive.writePulses(0x12345678);

        drive.seekOneTrack(1);

        expect(disc.readPulses(false, 3, 0)).toBe(neighbour);
    });

    it("offers both tracks a fat write covers to the next snapshot", () => {
        const disc = eightyTrackDisc();
        const drive = driveSteppedIn(disc, 1);
        disc.snapshotState();
        drive.writePulses(0x12345678);
        drive.seekOneTrack(1);

        disc.restoreState(disc.snapshotState());

        expect(disc.readPulses(false, 2, 0)).toBe(0x12345678);
        expect(disc.getTrack(false, 3).findSectors()).toEqual([]);
    });

    it("refuses a switch position no drive has", () => {
        const drive = new DiscDrive(0, new Scheduler(), BbcCyclesPerSecond);

        expect(() => (drive.tracksPerStep = 0)).toThrow(/one or two tracks/);
        expect(() => (drive.tracksPerStep = 3)).toThrow(/one or two tracks/);
        expect(drive.tracksPerStep).toBe(1);
    });

    /** The seek starts announced, as the noise hears them. */
    function seekStarts(drive) {
        const starts = [];
        drive.addEventListener("seekStart", (event) => starts.push([event.steps, event.stepMs]));
        return starts;
    }

    it("announces a seek as the steps the head will take, at the controller's rate", () => {
        const drive = driveSteppedIn(fortyTrackDisc(), 10);
        const starts = seekStarts(drive);

        drive.notifySeekAmount(10, 24);

        expect(starts).toEqual([[10, 24]]);
    });

    it("announces only the steps the head can take, none past either end of the surface", () => {
        const drive = driveSteppedIn(fortyTrackDisc(), 2);
        const starts = seekStarts(drive);

        drive.notifySeekAmount(-5, 6);
        drive.notifySeekAmount(100, 6);
        drive.notifySeekAmount(0, 6);

        const stepsLeft = (IbmDiscFormat.tracksPerDisc - 2 - drive.track) / 2;
        expect(starts).toEqual([
            [-2, 6],
            [stepsLeft, 6],
        ]);
    });

    it("announces the end of a seek it announced the start of, and no other", () => {
        const drive = driveSteppedIn(fortyTrackDisc(), 2);
        const ends = [];
        drive.addEventListener("seekEnd", (event) => ends.push(event.steps));

        drive.notifySeekEnd();
        expect(ends).toEqual([]);
        drive.notifySeekAmount(3, 24);
        drive.notifySeekEnd();
        drive.notifySeekEnd();
        expect(ends).toEqual([0]);
        drive.notifySeekAmount(0, 24);
        drive.notifySeekEnd();
        expect(ends).toEqual([0]);
    });

    it("ends with the steps the head took, not the ones it was stopped from taking", () => {
        const drive = driveSteppedIn(fortyTrackDisc(), 2);
        const ends = [];
        drive.addEventListener("seekEnd", (event) => ends.push(event.steps));

        drive.notifySeekAmount(-5, 24);
        for (let step = 0; step < 5; ++step) drive.seekOneTrack(-1);
        drive.notifySeekEnd();

        expect(ends).toEqual([2]);
        expect(drive.track).toBe(0);
    });

    it.each([
        ["once a seek with none to take is announced", (drive) => drive.notifySeekAmount(0, 24)],
        ["on a restore", (drive) => drive.restoreState(drive.snapshotState())],
    ])("forgets the steps of a seek that never ended %s", (_, forget) => {
        const drive = driveSteppedIn(fortyTrackDisc(), 2);
        const ends = [];
        drive.addEventListener("seekEnd", (event) => ends.push(event.steps));

        drive.notifySeekAmount(5, 24);
        drive.seekOneTrack(1);
        forget(drive);
        drive.notifySeekEnd();

        expect(ends).toEqual([]);
    });

    it("counts from where the head is, between the pitches of a switch made mid-surface", () => {
        const drive = new DiscDrive(0, new Scheduler(), BbcCyclesPerSecond);
        drive.setDisc(fortyTrackDisc());
        drive.seekOneTrack(1);
        drive.tracksPerStep = 2;
        const steps = [];
        drive.addEventListener("seekStart", (event) => steps.push(event.steps));

        drive.notifySeekAmount(-1, 24);
        drive.notifySeekAmount(2, 24);

        // From physical track 1: a short step out onto the edge still counts, then two in.
        expect(steps).toEqual([-1, 2]);
    });
});

describe("spindle motor", () => {
    it("comes up to speed over about half a second and stays there", () => {
        const { scheduler, drive } = spinningDrive();
        expect(drive.speed).toBeLessThan(0.05);
        scheduler.polltime(ms(150));
        expect(drive.speed).toBeCloseTo(0.63, 1);
        scheduler.polltime(ms(350));
        expect(drive.speed).toBeGreaterThan(0.95);
        scheduler.polltime(ms(2000));
        expect(drive.speed).toBeCloseTo(1, 3);
    });

    it("turns the disc slowly at first, so the index comes round late", () => {
        const { scheduler, drive } = spinningDrive();
        const started = scheduler.epoch;
        untilIndexRises(drive, scheduler);
        const firstIndex = scheduler.epoch - started;
        scheduler.polltime(ms(3000));
        const atSpeed = revolutionFrom(drive, scheduler);
        expect(firstIndex).toBeGreaterThan(ms(200) * 1.2);
        expect(atSpeed).toBe(ms(200));
    });

    it("turns at 300 rpm and spins up in the same time on the Atom's 1 MHz clock", () => {
        const atomMs = (n) => n * 1000;
        const { scheduler, drive } = spinningDrive(AtomCyclesPerSecond);
        scheduler.polltime(atomMs(150));
        expect(drive.speed).toBeCloseTo(0.63, 1);
        scheduler.polltime(atomMs(3000));
        expect(revolutionFrom(drive, scheduler)).toBe(atomMs(200));
    });

    it("keeps its speed through a stop and start at the same instant, and coasts through a longer one", () => {
        const { scheduler, drive } = spinningDrive();
        scheduler.polltime(ms(3000));
        drive.stopSpinning();
        drive.startSpinning();
        expect(drive.speed).toBeCloseTo(1, 3);
        drive.stopSpinning();
        scheduler.polltime(ms(500));
        expect(drive.speed).toBeCloseTo(0.37, 1);
        drive.startSpinning();
        expect(drive.speed).toBeCloseTo(0.37, 1);
    });

    it("keeps the disc turning through a brief stop, with no pulses while the motor is off", () => {
        const atSpeed = () => {
            const { scheduler, drive } = spinningDrive();
            let pulses = 0;
            drive.setPulsesCallback(() => ++pulses);
            scheduler.polltime(ms(3000));
            return { scheduler, drive, pulses: () => pulses };
        };
        const steady = atSpeed();
        const stopped = atSpeed();
        stopped.drive.stopSpinning();
        const pulsesAtStop = stopped.pulses();
        steady.scheduler.polltime(ms(1));
        stopped.scheduler.polltime(ms(1));
        expect(stopped.pulses()).toBe(pulsesAtStop);
        stopped.drive.startSpinning();
        steady.scheduler.polltime(ms(10));
        stopped.scheduler.polltime(ms(10));
        const oneByte = 1 / stopped.drive.trackLength;
        expect(Math.abs(stopped.drive.positionFraction - steady.drive.positionFraction)).toBeLessThanOrEqual(oneByte);
    });

    it("comes to rest about two seconds after the motor stops", () => {
        const { scheduler, drive } = spinningDrive();
        scheduler.polltime(ms(3000));
        drive.stopSpinning();
        scheduler.polltime(ms(1900));
        expect(scheduler.headroom()).not.toBe(Scheduler.MaxHeadroom);
        scheduler.polltime(ms(100));
        expect(scheduler.headroom()).toBe(Scheduler.MaxHeadroom);
    });

    it("brings back its head, its spin and its disc from a snapshot", () => {
        const withDisc = () => {
            const scheduler = new Scheduler();
            const drive = new DiscDrive(0, scheduler, BbcCyclesPerSecond);
            drive.setDisc(eightyTrackDisc());
            return {
                drive,
                scheduler,
                snapshotState: () => drive.snapshotState(),
                restoreState: (state) => drive.restoreState(state),
            };
        };
        return expectSnapshotRoundTrips(withDisc, ({ drive, scheduler }) => {
            drive.selectSide(true);
            drive.seekOneTrack(1);
            drive.startSpinning();
            scheduler.polltime(ms(150));
        });
    });

    it("carries a coast through a snapshot, turning unread until it comes to rest", () => {
        const { scheduler, drive } = spinningDrive();
        scheduler.polltime(ms(3000));
        drive.stopSpinning();
        scheduler.polltime(ms(350));
        const state = drive.snapshotState();

        const restoredScheduler = new Scheduler();
        const restored = new DiscDrive(0, restoredScheduler, BbcCyclesPerSecond);
        restored.setDisc(fortyTrackDisc());
        restored.setPulsesCallback(() => expect.fail("no pulses while coasting"));
        restored.restoreState(state);
        expect(restored.speed).toBeCloseTo(0.5, 1);
        const position = restored.positionFraction;
        restoredScheduler.polltime(ms(10));
        expect(restored.positionFraction).not.toBe(position);
        restoredScheduler.polltime(ms(2000));
        expect(restoredScheduler.headroom()).toBe(Scheduler.MaxHeadroom);
    });

    function untilIndexRises(drive, scheduler) {
        while (drive.indexPulse) scheduler.polltime(500);
        while (!drive.indexPulse) scheduler.polltime(500);
    }

    /** Cycles from the next rise of the index pulse to the one after, running the drive to find them. */
    function revolutionFrom(drive, scheduler) {
        untilIndexRises(drive, scheduler);
        const start = scheduler.epoch;
        untilIndexRises(drive, scheduler);
        return scheduler.epoch - start;
    }
});

describe("drive noise", () => {
    afterEach(() => vi.useRealTimers());

    function noisyDrives() {
        const calls = [];
        const ddNoise = {
            spinUp: () => calls.push("spinUp"),
            spinDown: () => calls.push("spinDown"),
            seekStart: (tracks, stepMs) => calls.push(`seek ${tracks} at ${stepMs}`),
            seekEnd: (steps) => calls.push(`seek end after ${steps}`),
        };
        const scheduler = new Scheduler();
        const drives = [
            new DiscDrive(0, scheduler, BbcCyclesPerSecond),
            new DiscDrive(1, scheduler, BbcCyclesPerSecond),
        ];
        attachDriveNoise(drives, ddNoise);
        return { drives, calls };
    }

    it("spins up with the first drive to start, stays up over a handover, and spins down with the last to stop", () => {
        vi.useFakeTimers();
        const { drives, calls } = noisyDrives();

        drives[0].startSpinning();
        vi.runAllTimers();
        expect(calls).toEqual(["spinUp"]);

        drives[0].stopSpinning();
        drives[1].startSpinning();
        vi.runAllTimers();
        expect(calls).not.toContain("spinDown");

        drives[1].stopSpinning();
        vi.runAllTimers();
        expect(calls.at(-1)).toBe("spinDown");
        expect(calls.filter((call) => call === "spinDown")).toHaveLength(1);
    });

    it("follows a snapshot restored over a stopped drive, then stops with it", () => {
        vi.useFakeTimers();
        const { drives, calls } = noisyDrives();
        const turning = new DiscDrive(0, new Scheduler(), BbcCyclesPerSecond);
        turning.startSpinning();

        drives[0].restoreState(turning.snapshotState());
        vi.runAllTimers();
        expect(calls.at(-1)).toBe("spinUp");

        drives[0].stopSpinning();
        vi.runAllTimers();
        expect(calls.at(-1)).toBe("spinDown");
    });

    it("stops for a stopped snapshot restored over a turning drive", () => {
        vi.useFakeTimers();
        const { drives, calls } = noisyDrives();
        drives[0].startSpinning();
        vi.runAllTimers();

        drives[0].restoreState(new DiscDrive(0, new Scheduler(), BbcCyclesPerSecond).snapshotState());
        vi.runAllTimers();
        expect(calls.at(-1)).toBe("spinDown");
    });

    it("stays balanced over restores that leave a drive as it was", () => {
        vi.useFakeTimers();
        const { drives, calls } = noisyDrives();
        drives[0].startSpinning();
        const turning = drives[0].snapshotState();
        drives[0].restoreState(turning);
        drives[0].restoreState(turning);
        drives[1].restoreState(drives[1].snapshotState());

        drives[0].stopSpinning();
        vi.runAllTimers();
        expect(calls.at(-1)).toBe("spinDown");
    });

    it("passes every seek's start and end on, from either drive", () => {
        const { drives, calls } = noisyDrives();

        drives[0].notifySeekAmount(5, 24);
        drives[0].seekOneTrack(1);
        drives[0].notifySeekEnd();
        drives[1].notifySeekAmount(3, 6);
        drives[1].notifySeekEnd();

        expect(calls).toEqual(["seek 5 at 24", "seek end after 1", "seek 3 at 6", "seek end after 0"]);
    });
});
