import { afterEach, describe, it, expect, vi } from "vitest";

import { Disc, DiscConfig, IbmDiscFormat, loadSsd } from "../../src/disc.js";
import { DiscDrive } from "../../src/disc-drive.js";
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
        drive.is40Track = true;
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

    it("writes over the track its head also covers", () => {
        const disc = fortyTrackDisc();
        const drive = driveSteppedIn(disc, 1);
        drive.writePulses(0x12345678);

        drive.seekOneTrack(1);

        expect(disc.readPulses(false, 3, 0)).toBe(0x12345678);
        expect(disc.getTrack(false, 3).length).toBe(disc.getTrack(false, 2).length);
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

    it("offers both halves of a fat track to the next snapshot", () => {
        const disc = fortyTrackDisc();
        const drive = driveSteppedIn(disc, 1);
        const before = disc.snapshotState().tracks;
        drive.writePulses(0x12345678);

        drive.seekOneTrack(1);

        const after = disc.snapshotState().tracks;
        expect(after["false:2"]).not.toBe(before["false:2"]);
        expect(after["false:3"]).not.toBe(before["false:3"]);
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
