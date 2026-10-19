import { describe, it, expect } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { IntelFdc } from "../../src/intel-fdc.js";
import { fake6502 } from "../../src/fake6502.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { findModel } from "../../src/models.js";

const AtomModel = findModel("Atom");

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

describe("Intel 8271 tests", function () {
    const busy = 0x80;
    const commandFull = 0x40;
    const paramFull = 0x20;
    const resultReady = 0x10;
    const loadHead = 0x08;
    const driveSelect1 = 0x40;
    const writeRegCmd = 0x3a;
    const readDriveStatusCmd = 0x2c;
    const mmioWrite = 0x23;
    const seekCmd = (0x0a << 2) | driveSelect1 | 1;

    it("should construct and start out idle", () => {
        const fakeCpu = fake6502();
        const scheduler = new Scheduler();
        const fdc = new IntelFdc(fakeCpu, scheduler);
        expect(fdc.internalStatus).toBe(0);
        expect(scheduler.headroom()).toBe(Scheduler.MaxHeadroom);
    });

    it("should go busy as soon as a command is registered", () => {
        const fakeCpu = fake6502();
        const scheduler = new Scheduler();
        const fdc = new IntelFdc(fakeCpu, scheduler);
        fdc.write(0, writeRegCmd);
        expect(fdc.internalStatus).toBe(busy);
    });

    it("should spin up when poked", () => {
        const fakeCpu = fake6502();
        const scheduler = new Scheduler();
        const fakeDrive = new FakeDrive();
        const fdc = new IntelFdc(fakeCpu, scheduler, [fakeDrive]);
        expect(fdc._driveOut & loadHead).toBe(0);
        expect(fakeDrive.spinning).toBe(false);
        sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
        expect(fdc._driveOut & loadHead).toBe(loadHead);
        expect(fakeDrive.spinning).toBe(true);
    });
    it("should seek to a track", () => {
        const fakeCpu = fake6502();
        const scheduler = new Scheduler();
        const fakeDrive = new FakeDrive();
        const fdc = new IntelFdc(fakeCpu, scheduler, [fakeDrive]);
        sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
        // nb will seek two more due to bad track nonsense
        sendCommand(fdc, seekCmd, 2);
        expect(fakeDrive.track).toBe(1);
        // We should have some 3ms step scheduled
        expect(scheduler.headroom()).toBe(6000);
        scheduler.polltime(6000);
        expect(fakeDrive.track).toBe(2);
        // We should reach and stop at track 4.
        scheduler.polltime(6000 * 10);
        expect(fakeDrive.track).toBe(4);
    });

    describe("seek noise", () => {
        const specifyCmd = 0x35;
        const initialisation = 0x0d;
        const badTracksDrive0 = 0x10;

        it("announces the seek's tracks at the drive's own 3 ms when no rate was specified, and its end", () => {
            const fakeDrive = new FakeDrive();
            const scheduler = new Scheduler();
            const fdc = new IntelFdc(fake6502(), scheduler, [fakeDrive]);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            sendCommand(fdc, seekCmd, 2);
            expect(fakeDrive.seeks).toEqual([[4, 3]]);
            scheduler.polltime(6000 * 10);
            expect(fakeDrive.seeks).toEqual([[4, 3], "end"]);
        });

        it("announces the rate the DFS specified, doubled for a 5.25 inch drive", () => {
            const fakeDrive = new FakeDrive();
            const scheduler = new Scheduler();
            const fdc = new IntelFdc(fake6502(), scheduler, [fakeDrive]);
            sendCommand(fdc, specifyCmd, initialisation, 12, 10, 0xc8);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            sendCommand(fdc, seekCmd, 2);
            expect(fakeDrive.seeks).toEqual([[4, 24]]);
        });

        it("announces the steps its track register calls for, which the head takes wherever it is", () => {
            const scheduler = new Scheduler();
            const cpu = fake6502();
            const drive = new DiscDrive(0, scheduler, cpu.peripheralCyclesPerSecond);
            const events = [];
            drive.addEventListener("seekStart", (event) => events.push([event.steps, event.stepMs]));
            drive.addEventListener("seekEnd", (event) => events.push(`end after ${event.steps}`));
            const fdc = new IntelFdc(cpu, scheduler, [drive]);
            sendCommand(fdc, specifyCmd, badTracksDrive0, 0xff, 0xff, 0);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            sendCommand(fdc, seekCmd, 13);
            scheduler.polltime(6000 * 20);
            expect(drive.track).toBe(13);
            for (let track = 13; track < 20; ++track) drive.seekOneTrack(1);
            events.length = 0;
            sendCommand(fdc, seekCmd, 10);
            scheduler.polltime(6000 * 10);
            expect(events).toEqual([[-3, 3], "end after 3"]);
            expect(drive.track).toBe(17);
        });

        it("announces nothing for a seek to the track the head is on", () => {
            const fakeDrive = new FakeDrive();
            const scheduler = new Scheduler();
            const fdc = new IntelFdc(fake6502(), scheduler, [fakeDrive]);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            sendCommand(fdc, seekCmd, 2);
            scheduler.polltime(6000 * 10);
            fakeDrive.seeks.length = 0;
            sendCommand(fdc, seekCmd, 2);
            scheduler.polltime(6000 * 10);
            expect(fakeDrive.seeks).toEqual([]);
        });
    });

    it("steps at the specified rate in milliseconds on the Atom's 1 MHz clock", () => {
        const specifyCmd = 0x35;
        const initialisation = 0x0d;
        const scheduler = new Scheduler();
        const fdc = new IntelFdc(fake6502(AtomModel), scheduler, [new FakeDrive()]);
        sendCommand(fdc, specifyCmd, initialisation, 12, 10, 0xc8);
        sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
        sendCommand(fdc, seekCmd, 2);
        expect(scheduler.headroom()).toBe(24 * 1000);
    });

    describe("head load", () => {
        const specifyCmd = 0x35;
        const initialisation = 0x0d;

        it("loads the head over eight milliseconds a unit, as a 5.25 inch drive doubles it", () => {
            const fakeDrive = new FakeDrive();
            const scheduler = new Scheduler();
            const fdc = new IntelFdc(fake6502(), scheduler, [fakeDrive]);
            sendCommand(fdc, specifyCmd, initialisation, 12, 10, 0xc8);
            sendCommand(fdc, writeRegCmd, mmioWrite, driveSelect1);
            sendCommand(fdc, seekCmd, 1);
            // Steps at the 24 ms the specify asked for, two extra for the bad track registers.
            while (scheduler.headroom() === 24 * 2000) scheduler.polltime(scheduler.headroom());
            expect(fakeDrive.track).toBe(3);
            // The head, unloaded until now, takes 8 units of 8 ms to load.
            expect(scheduler.headroom()).toBe(8 * 8 * 2000);
        });
    });

    describe("ready", () => {
        const ms = (n) => n * 2000;

        function readyFdc(cpu = fake6502()) {
            const fakeDrive = new FakeDrive();
            const scheduler = new Scheduler();
            const fdc = new IntelFdc(cpu, scheduler, [fakeDrive]);
            // As the DFS specifies: the head stays loaded for 12 revolutions after a command,
            // so reading the status does not deselect the drive.
            sendCommand(fdc, 0x35, 0x0d, 12, 10, 0xc8);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            const indexPulse = () => {
                fakeDrive.indexPulse = true;
                fakeDrive.pulsesCallback(0, 32);
                fakeDrive.indexPulse = false;
                fakeDrive.pulsesCallback(0, 32);
            };
            // The status is latched, so it takes two reads to see a change; the drive the
            // command byte's 0x40 selects reports as RDY0.
            const ready0 = 0x04;
            const ready = () => {
                sendCommand(fdc, readDriveStatusCmd | driveSelect1);
                sendCommand(fdc, readDriveStatusCmd | driveSelect1);
                return (fdc.read(1) & ready0) === ready0;
            };
            return { fdc, scheduler, indexPulse, ready };
        }

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
            const { scheduler, indexPulse, ready } = readyFdc(fake6502(AtomModel));
            indexPulse();
            scheduler.polltime(atomMs(200));
            indexPulse();
            expect(ready()).toBe(true);
            scheduler.polltime(atomMs(300));
            indexPulse();
            expect(ready()).toBe(false);
        });

        it("counts edges from the level the newly selected drive already shows", () => {
            const fakeDrive = new FakeDrive();
            fakeDrive.indexPulse = true;
            const scheduler = new Scheduler();
            const fdc = new IntelFdc(fake6502(), scheduler, [fakeDrive]);
            sendCommand(fdc, 0x35, 0x0d, 12, 10, 0xc8);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            const ready0 = 0x04;
            const ready = () => {
                sendCommand(fdc, readDriveStatusCmd | driveSelect1);
                sendCommand(fdc, readDriveStatusCmd | driveSelect1);
                return (fdc.read(1) & ready0) === ready0;
            };
            // Still high from before selection: not an edge.
            fakeDrive.pulsesCallback(0, 32);
            fakeDrive.indexPulse = false;
            fakeDrive.pulsesCallback(0, 32);
            for (const expected of [false, true]) {
                scheduler.polltime(ms(200));
                fakeDrive.indexPulse = true;
                fakeDrive.pulsesCallback(0, 32);
                fakeDrive.indexPulse = false;
                fakeDrive.pulsesCallback(0, 32);
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
            sendCommand(fdc, writeRegCmd | driveSelect1, mmioWrite, driveSelect1);
            scheduler.polltime(ms(100));
            sendCommand(fdc, writeRegCmd | driveSelect1, mmioWrite, loadHead | driveSelect1);
            expect(ready()).toBe(true);
        });

        it("goes when the drive is deselected", () => {
            const { fdc, scheduler, indexPulse, ready } = readyFdc();
            indexPulse();
            scheduler.polltime(ms(200));
            indexPulse();
            expect(ready()).toBe(true);
            sendCommand(fdc, writeRegCmd, mmioWrite, 0);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            expect(ready()).toBe(false);
        });
    });

    describe("head unload", () => {
        const statusAddr = 0;
        const resultAddr = 1;
        const dataAddr = 4;
        const needData = 0x04;
        const modeRegister = 0x17;
        const dfsMode = 0xc1;
        const readDataCmd = (0x04 << 2) | driveSelect1 | 3;
        const specifyCmd = 0x35;
        const initialisation = 0x0d;
        const badTracksDrive0 = 0x10;
        const oneSectorOf256Bytes = 0x21;
        const SectorBytes = 256;
        const SectorsPerTrack = 10;
        const Tracks = 80;
        const pollTicks = 16;
        const ms = (n) => n * 2000;

        function dfsFdc() {
            const scheduler = new Scheduler();
            const cpu = fake6502();
            const drive = new DiscDrive(0, scheduler, cpu.peripheralCyclesPerSecond);
            const data = new Uint8Array(Tracks * SectorsPerTrack * SectorBytes);
            for (let track = 0; track < Tracks; ++track) data[track * SectorsPerTrack * SectorBytes] = track;
            drive.setDisc(loadSsd(new Disc(true, new DiscConfig(), "test.ssd"), data, false, null));
            const fdc = new IntelFdc(cpu, scheduler, [drive]);
            sendCommand(fdc, writeRegCmd, modeRegister, dfsMode);
            // DFS 1.20's: 24 ms steps, 20 ms settle, 64 ms head load, unload after 12 revolutions.
            sendCommand(fdc, specifyCmd, initialisation, 12, 10, 0xc8);
            sendCommand(fdc, specifyCmd, badTracksDrive0, 0xff, 0xff, 0);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            scheduler.polltime(ms(1000));
            const readStatus = () => {
                sendCommand(fdc, readDriveStatusCmd | driveSelect1);
                return fdc.read(resultAddr);
            };
            readStatus();
            const readFirstByte = (track) => {
                sendCommand(fdc, readDataCmd, track, 0, oneSectorOf256Bytes);
                let firstByte = null;
                while (fdc.peek(statusAddr) & busy) {
                    scheduler.polltime(pollTicks);
                    if (fdc.peek(statusAddr) & needData) {
                        const byte = fdc.read(dataAddr);
                        firstByte ??= byte;
                    }
                }
                return { result: fdc.read(resultAddr), firstByte };
            };
            return { fdc, scheduler, drive, readStatus, readFirstByte };
        }

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
                sendCommand(rewritten.fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
                steady.scheduler.polltime(ms(1));
                rewritten.scheduler.polltime(ms(1));
            }
            expect(rewritten.drive.positionFraction).toBe(steady.drive.positionFraction);
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
        const statusAddr = 0;
        const resultAddr = 1;
        const dataAddr = 4;
        const needData = 0x04;
        const modeRegister = 0x17;
        const dfsMode = 0xc1;
        const readDataCmd = (0x04 << 2) | driveSelect1 | 3;
        const specifyCmd = 0x35;
        const initialisation = 0x0d;
        const oneSectorOf256Bytes = 0x21;
        const sectorByte = 0x5a;
        const SectorBytes = 256;
        const SectorsPerTrack = 10;
        const pollTicks = 16;
        const maxTicks = 2 * 1000 * 1000;

        function fdcWithDisc() {
            const scheduler = new Scheduler();
            const cpu = fake6502();
            const drive = new DiscDrive(0, scheduler, cpu.peripheralCyclesPerSecond);
            const data = new Uint8Array(2 * SectorsPerTrack * SectorBytes);
            data.fill(sectorByte, 0, SectorBytes);
            drive.setDisc(loadSsd(new Disc(true, new DiscConfig(), "test.ssd"), data, false, null));
            const fdc = new IntelFdc(cpu, scheduler, [drive]);
            sendCommand(fdc, writeRegCmd, modeRegister, dfsMode);
            // As the DFS specifies, keeping the head loaded between commands.
            sendCommand(fdc, specifyCmd, initialisation, 12, 10, 0xc8);
            sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | driveSelect1);
            scheduler.polltime(maxTicks);
            // The drive status is latched, so the second read is the one that sees it ready.
            for (let i = 0; i < 2; ++i) {
                sendCommand(fdc, readDriveStatusCmd | driveSelect1);
                fdc.read(resultAddr);
            }
            return { fdc, scheduler };
        }

        it("shows the data byte without lowering need-data, as reading it does", () => {
            const { fdc, scheduler } = fdcWithDisc();
            sendCommand(fdc, readDataCmd, 0, 0, oneSectorOf256Bytes);
            for (let ticks = 0; !(fdc.peek(statusAddr) & needData) && ticks < maxTicks; ticks += pollTicks) {
                scheduler.polltime(pollTicks);
            }
            expect(fdc.peek(statusAddr) & needData).toBe(needData);
            expect(fdc.peek(dataAddr)).toBe(sectorByte);
            expect(fdc.peek(statusAddr) & needData).toBe(needData);
            expect(fdc.read(dataAddr)).toBe(sectorByte);
            expect(fdc.peek(statusAddr) & needData).toBe(0);
        });
    });

    describe("status register", () => {
        const statusAddr = 0;
        const resultAddr = 1;
        const readSpecialRegisterCmd = 0x3d;
        const modeRegister = 0x17;
        const dfsMode = 0xc1;

        function makeFdc() {
            return new IntelFdc(fake6502(), new Scheduler(), [new FakeDrive()]);
        }

        it("does not report command or parameter register full after the mode register is written", () => {
            const fdc = makeFdc();
            sendCommand(fdc, writeRegCmd, modeRegister, dfsMode);
            expect(fdc.read(statusAddr)).toBe(0);
            sendCommand(fdc, readDriveStatusCmd);
            expect(fdc.read(statusAddr)).toBe(resultReady);
        });

        it("keeps the mode bits in the shared internal byte where read special register sees them", () => {
            const fdc = makeFdc();
            sendCommand(fdc, writeRegCmd, modeRegister, dfsMode);
            sendCommand(fdc, readSpecialRegisterCmd, modeRegister);
            expect(fdc.read(resultAddr)).toBe(dfsMode & ~commandFull);
        });

        it("shows busy but not command register full once a command taking parameters is written", () => {
            const fdc = makeFdc();
            sendCommand(fdc, writeRegCmd);
            expect(fdc.read(statusAddr) & (busy | commandFull)).toBe(busy);
        });

        it("does not report parameter register full after any parameter write", () => {
            const fdc = makeFdc();
            sendCommand(fdc, writeRegCmd, modeRegister);
            expect(fdc.read(statusAddr) & (busy | paramFull)).toBe(busy);
            sendCommand(fdc, writeRegCmd, modeRegister, dfsMode);
            expect(fdc.read(statusAddr) & (busy | paramFull)).toBe(0);
        });
    });
});
