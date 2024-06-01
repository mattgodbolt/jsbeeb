import { describe, it } from "mocha";
import assert from "assert";

import { Disc, IbmDiscFormat } from "../../disc.js";
import { DiscDrive } from "../../disc_drive.js";
import { Scheduler } from "../../scheduler.js";

describe("Disc drive tests", function () {
    it("starts empty", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        assert.equal(drive.trackLength, IbmDiscFormat.bytesPerTrack);
        assert.equal(drive.disc, null);
        assert(!drive.spinning);
        drive.setPulsesCallback(() => {
            assert(false); // no callbacks expected
        });
        scheduler.polltime(1000000);
    });
    it("adds a disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        const disc = Disc.createBlank();
        drive.addDisc(disc);
        assert.equal(drive.disc, disc);
    });
    it("calls back with pulses after spinning starts", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.addDisc(Disc.createBlank());
        drive.setPulsesCallback(() => {
            assert(false); // no callbacks expected
        });
        scheduler.polltime(1000000);
        drive.startSpinning();
        let numPulses = 0;
        drive.setPulsesCallback(() => numPulses++);
        scheduler.polltime(500);
        assert.equal(numPulses, 4);
        drive.stopSpinning();
        drive.setPulsesCallback(() => {
            assert(false); // no callbacks expected
        });
        scheduler.polltime(1000000);
    });
    it("generates quasi random pulses with a blank disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.addDisc(Disc.createBlank());
        drive.getQuasiRandomPulses = () => {
            return 0xdeadbeef;
        };
        let called = false;
        drive.setPulsesCallback((pulses, numPulses) => {
            called = true;
            assert.equal(numPulses, 32);
            assert.equal(pulses, 0xdeadbeef);
        });
        drive.startSpinning();
        scheduler.polltime(1000000);
        assert(called);
    });
    it("asserts index all the time with no disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        assert(drive.indexPulse);
    });
    it("asserts index periodically with a spinning disc", () => {
        const scheduler = new Scheduler();
        const drive = new DiscDrive(0, scheduler);
        drive.addDisc(Disc.createBlank());
        drive.startSpinning();
        let previousIndex = drive.indexPulse;
        let risingEdges = 0;
        const cyclesPerSecond = 2 * 1000 * 1000;
        const cyclesPerIter = cyclesPerSecond / 1000;
        const oneMinuteCycles = cyclesPerSecond * 60;
        const rpm = 300;
        for (let cycle = 0; cycle < oneMinuteCycles; cycle += cyclesPerIter) {
            scheduler.polltime(cyclesPerIter);
            if (drive.indexPulse && !previousIndex) risingEdges++;
            previousIndex = drive.indexPulse;
        }
        assert.equal(risingEdges, rpm);
    });
});
