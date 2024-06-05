import { describe, it } from "mocha";
import assert from "assert";

import { Scheduler } from "../../scheduler.js";
import { IntelFdc } from "../../intel-fdc.js";
import { fake6502 } from "../../fake6502.js";

class FakeDrive {
    constructor() {
        this.spinning = false;
        this.pulsesCallback = null;
        this.upperSide = false;
    }
    selectSide(side) { this.upperSide = side; }
    setPulsesCallback(callback) {
        this.pulsesCallback = callback;
    }
    startSpinning() {
        this.spinning = true;
    }
    stopSpinning() {
        this.spinning = false;
    }
}

describe("Intel 8271 tests", function () {
    it("should contruct and start out idle", () => {
        const fakeCpu = fake6502();
        const scheduler = new Scheduler();
        const fdc = new IntelFdc(fakeCpu, scheduler);
        assert.equal(fdc.internalStatus, 0);
        assert.equal(scheduler.headroom(), Scheduler.MaxHeadroom);
    });

    it("should go busy as soon as a command is registered", () => {
        const fakeCpu = fake6502();
        const scheduler = new Scheduler();
        const fdc = new IntelFdc(fakeCpu, scheduler);
        fdc.write(0, 0x3a);
        assert.equal(fdc.internalStatus, 0x80); // 0x80 = busy
    });

    it("should spin up when poked", () => {
        const fakeCpu = fake6502();
        const scheduler = new Scheduler();
        const fakeDrive = new FakeDrive();
        const fdc = new IntelFdc(fakeCpu, scheduler);
        fdc.setDrives(fakeDrive, null);
        const loadHead = 0x08;
        // Sequence used by DFS to spin up a disc
        assert.equal(fdc._driveOut & loadHead, 0);
        assert(!fakeDrive.spinning);
        fdc.write(0, 0x3a);
        fdc.write(1, 0x23);
        fdc.write(1, 0x48);
        assert.equal(fdc._driveOut & loadHead, loadHead);
        assert(fakeDrive.spinning);
    });
});
