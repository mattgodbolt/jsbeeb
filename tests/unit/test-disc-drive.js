import { describe, it, expect } from "vitest";

import { Disc, IbmDiscFormat } from "../../src/disc.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Scheduler } from "../../src/scheduler.js";

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
