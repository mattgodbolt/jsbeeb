import { describe, it, expect } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { IntelFdc } from "../../src/intel-fdc.js";
import { fake6502 } from "../../src/fake6502.js";

class FakeDrive {
    constructor() {
        this.spinning = false;
        this.pulsesCallback = null;
        this.upperSide = false;
        this.track = 0;
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
    notifySeek() {}
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
    const select1 = 0x40;
    const writeRegCmd = 0x3a;
    const readDriveStatusCmd = 0x2c;
    const mmioWrite = 0x23;
    const seekCmd = (0x0a << 2) | select1 | 1;

    it("should contruct and start out idle", () => {
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
        sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | select1);
        expect(fdc._driveOut & loadHead).toBe(loadHead);
        expect(fakeDrive.spinning).toBe(true);
    });
    it("should seek to a track", () => {
        const fakeCpu = fake6502();
        const scheduler = new Scheduler();
        const fakeDrive = new FakeDrive();
        const fdc = new IntelFdc(fakeCpu, scheduler, [fakeDrive]);
        sendCommand(fdc, writeRegCmd, mmioWrite, loadHead | select1);
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
