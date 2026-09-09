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
        let previousIndex = drive.indexPulse;
        let risingEdges = 0;
        const cyclesPerSecond = 2 * 1000 * 1000;
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

    it("makes the seek noise of a head crossing twice as many tracks", () => {
        const drive = driveSteppedIn(fortyTrackDisc(), 10);
        const steps = [];
        drive.addEventListener("step", (event) => steps.push(event.stepAmount));

        drive.notifySeek(20);

        // Ten of the tracks the controller counts in, which is twenty of the surface's.
        expect(steps).toEqual([20]);
    });
});

describe("drive noise", () => {
    afterEach(() => vi.useRealTimers());

    function noisyDrives(seekSeconds = 0) {
        const calls = [];
        const ddNoise = {
            spinUp: () => calls.push("spinUp"),
            spinDown: () => calls.push("spinDown"),
            seek: (amount) => {
                calls.push(`seek ${amount}`);
                return seekSeconds;
            },
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

    it("seeks by the tracks the head crosses", () => {
        vi.useFakeTimers();
        const { drives, calls } = noisyDrives(0.5);

        drives[0].notifySeekAmount(5);
        vi.advanceTimersByTime(600);
        drives[1].notifySeekAmount(-3);

        expect(calls).toEqual(["seek 5", "seek -3"]);
    });

    it("lets one seek noise finish before starting another", () => {
        vi.useFakeTimers();
        const { drives, calls } = noisyDrives(0.5);

        drives[0].notifySeekAmount(1);
        vi.advanceTimersByTime(400);
        drives[0].notifySeekAmount(1);
        expect(calls).toEqual(["seek 1"]);

        vi.advanceTimersByTime(200);
        drives[0].notifySeekAmount(1);
        expect(calls).toEqual(["seek 1", "seek 1"]);
    });
});
