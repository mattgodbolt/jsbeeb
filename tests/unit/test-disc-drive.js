import { afterEach, describe, it, expect, vi } from "vitest";

import { Disc, DiscConfig, IbmDiscFormat, loadSsd } from "../../src/disc.js";
import { attachDriveNoise, DiscDrive } from "../../src/disc-drive.js";
import { Scheduler } from "../../src/scheduler.js";

const SectorsPerTrack = 10;
const SectorSize = 256;

function ssdDisc(numTracks, is40Track) {
    const config = new DiscConfig();
    config.expandTo80 = is40Track;
    const data = new Uint8Array(numTracks * SectorsPerTrack * SectorSize).fill(0x55);
    return loadSsd(new Disc(true, config, "test.ssd"), data, false, null);
}

const eightyTrackDisc = () => ssdDisc(80, false);
const fortyTrackDisc = () => ssdDisc(40, true);

describe("Disc drive tests", function () {
    it("starts empty", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        expect(drive.trackLength).toBe(IbmDiscFormat.bytesPerTrack);
        expect(drive.disc).toBeFalsy();
        expect(drive.spinning).toBe(false);
        drive.setPulsesCallback(() => {
            expect.fail("no callbacks expected");
        });
        scheduler.polltime(1000000);
    });
    it("sets a disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        const disc = Disc.createBlank();
        drive.setDisc(disc);
        expect(drive.disc).toBe(disc);
    });
    it("calls back with pulses after spinning starts", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.setDisc(0, Disc.createBlank());
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
    it("generates quasi random pulses with a blank disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.setDisc(Disc.createBlank());
        drive.getQuasiRandomPulses = () => {
            return 0xdeadbeef;
        };
        let called = false;
        drive.setPulsesCallback((pulses, numPulses) => {
            called = true;
            expect(numPulses).toBe(32);
            expect(pulses).toBe(0xdeadbeef);
        });
        drive.startSpinning();
        scheduler.polltime(1000000);
        expect(called).toBe(true);
    });
    it("makes quasi random pulses the FM decoder reads as clean data that changes over time", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        const first = IbmDiscFormat._2usPulsesToFm(drive.getQuasiRandomPulses());
        expect(first).toMatchObject({ clocks: 0xff, iffyPulses: false });
        const seen = new Set();
        for (let i = 0; i < 8; ++i) {
            scheduler.polltime(1000);
            seen.add(IbmDiscFormat._2usPulsesToFm(drive.getQuasiRandomPulses()).data);
        }
        expect(seen.size).toBeGreaterThan(1);
    });
    it("asserts index all the time with no disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        expect(drive.indexPulse).toBe(true);
    });
    it("steps one track at a time for an 80 track disc", () => {
        const drive = new DiscDrive(0, new Scheduler());
        drive.setDisc(eightyTrackDisc());

        drive.seekOneTrack(1);
        drive.seekOneTrack(1);

        expect(drive.track).toBe(2);
    });

    it("asserts index periodically with a spinning disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.setDisc(Disc.createBlank());
        drive.startSpinning();
        const cyclesPerSecond = 2 * 1000 * 1000;
        scheduler.polltime(3 * cyclesPerSecond);
        let previousIndex = drive.indexPulse;
        let risingEdges = 0;
        const cyclesPerIter = cyclesPerSecond / 60;
        const rpm = 300;
        const testSeconds = 5;
        for (let cycle = 0; cycle < testSeconds * cyclesPerSecond; cycle += cyclesPerIter) {
            scheduler.polltime(cyclesPerIter);
            if (drive.indexPulse && !previousIndex) risingEdges++;
            previousIndex = drive.indexPulse;
        }
        expect(risingEdges).toBe((rpm / 60) * testSeconds);
    });
});

describe("40 track discs", () => {
    afterEach(() => vi.restoreAllMocks());

    /** @returns {DiscDrive} a drive with its 40/80 switch at 40, stepped `steps` times inwards. */
    function driveSteppedIn(disc, steps) {
        const drive = new DiscDrive(0, new Scheduler());
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
        const drive = new DiscDrive(0, new Scheduler());
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
        const drive = new DiscDrive(0, new Scheduler());
        drive.setDisc(disc);
        drive.seekOneTrack(1);
        drive.seekOneTrack(1);
        const neighbour = disc.readPulses(false, 3, 0);
        drive.writePulses(0x12345678);

        drive.seekOneTrack(1);

        expect(disc.readPulses(false, 3, 0)).toBe(neighbour);
    });

    it("offers both tracks a fat write covers to the next snapshot", () => {
        const disc = fortyTrackDisc();
        const drive = driveSteppedIn(disc, 1);
        const before = disc.snapshotState().tracks;
        drive.writePulses(0x12345678);

        drive.seekOneTrack(1);

        const after = disc.snapshotState().tracks;
        expect(after["false:2"]).not.toBe(before["false:2"]);
        expect(after["false:3"]).not.toBe(before["false:3"]);
    });

    it("refuses a switch position no drive has", () => {
        const drive = new DiscDrive(0, new Scheduler());

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

        drive.notifySeek(20, 24);

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
        let ends = 0;
        drive.addEventListener("seekEnd", () => ++ends);

        drive.notifySeekEnd();
        expect(ends).toBe(0);
        drive.notifySeekAmount(3, 24);
        drive.notifySeekEnd();
        drive.notifySeekEnd();
        expect(ends).toBe(1);
        drive.notifySeekAmount(0, 24);
        drive.notifySeekEnd();
        expect(ends).toBe(1);
    });

    it("counts from where the head is, between the pitches of a switch made mid-surface", () => {
        const drive = new DiscDrive(0, new Scheduler());
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
    const ms = (n) => n * 2000;

    it("comes up to speed over about half a second and stays there", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.setDisc(fortyTrackDisc());
        drive.startSpinning();
        expect(drive.speed).toBeLessThan(0.05);
        scheduler.polltime(ms(150));
        expect(drive.speed).toBeCloseTo(0.63, 1);
        scheduler.polltime(ms(350));
        expect(drive.speed).toBeGreaterThan(0.95);
        scheduler.polltime(ms(2000));
        expect(drive.speed).toBeCloseTo(1, 3);
    });

    it("turns the disc slowly at first, so the index comes round late", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.setDisc(fortyTrackDisc());
        drive.startSpinning();
        const started = scheduler.epoch;
        untilIndexRises(drive, scheduler);
        const firstIndex = scheduler.epoch - started;
        scheduler.polltime(ms(3000));
        const atSpeed = revolutionFrom(drive, scheduler);
        expect(firstIndex).toBeGreaterThan(DiscDrive.TicksPerRevolution * 1.2);
        expect(atSpeed).toBeCloseTo(DiscDrive.TicksPerRevolution, -3);
    });

    it("keeps its speed through a stop and start at the same instant, and coasts through a longer one", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.setDisc(fortyTrackDisc());
        drive.startSpinning();
        scheduler.polltime(ms(3000));
        drive.stopSpinning();
        drive.startSpinning();
        expect(drive.speed).toBeCloseTo(1, 3);
        drive.stopSpinning();
        scheduler.polltime(ms(1000));
        expect(drive.speed).toBeCloseTo(0.37, 1);
        drive.startSpinning();
        expect(drive.speed).toBeCloseTo(0.37, 1);
    });

    it("carries its speed through a snapshot", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.setDisc(fortyTrackDisc());
        drive.startSpinning();
        scheduler.polltime(ms(150));
        const state = drive.snapshotState();
        expect(state.speed).toBeCloseTo(0.63, 1);
        const restored = new DiscDrive(0, scheduler);
        restored.setDisc(fortyTrackDisc());
        restored.restoreState(state);
        expect(restored.speed).toBeCloseTo(0.63, 1);
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
            seekEnd: () => calls.push("seek end"),
        };
        const scheduler = new Scheduler();
        const drives = [new DiscDrive(0, scheduler), new DiscDrive(1, scheduler)];
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

    it("passes every seek's start and end on, from either drive", () => {
        const { drives, calls } = noisyDrives();

        drives[0].notifySeekAmount(5, 24);
        drives[0].notifySeekEnd();
        drives[1].notifySeekAmount(3, 6);
        drives[1].notifySeekEnd();

        expect(calls).toEqual(["seek 5 at 24", "seek end", "seek 3 at 6", "seek end"]);
    });
});
