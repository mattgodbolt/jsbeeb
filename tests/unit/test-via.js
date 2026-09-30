import { describe, it, expect, beforeEach } from "vitest";
import { SysVia, UserVia } from "../../src/via.js";
import { Scheduler } from "../../src/scheduler.js";
import { BBC, keyCodes } from "../../src/keymap.js";

function makeFakeCpu() {
    return { interrupt: 0 };
}

function makeFakeVideo() {
    return { setScreenHwScroll: () => {} };
}

function makeFakeSoundChip() {
    return { updateSlowDataBus: () => {} };
}

function makeFakeCmos() {
    return { writeControl: () => {}, read: () => 0xff };
}

function makeFakeUserPortPeripheral() {
    return { read: () => 0xff, write: () => {} };
}

describe("Via snapshotState / restoreState", () => {
    let scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
    });

    describe("base Via (via UserVia)", () => {
        function makeUserVia() {
            return new UserVia(cpu, scheduler, false, makeFakeUserPortPeripheral());
        }

        it("should snapshot and restore all register fields", () => {
            const via = makeUserVia();
            // Set some non-default state
            via.ora = 0x42;
            via.orb = 0x37;
            via.ira = 0xaa;
            via.irb = 0xbb;
            via.ddra = 0xf0;
            via.ddrb = 0x0f;
            via.sr = 0x55;
            via.acr = 0x60;
            via.pcr = 0x22;
            via.t1hit = false;
            via.t2hit = false;
            via.t1_pb7 = 1;
            via.ca1 = true;
            via.cb2 = true;

            const snapshot = via.snapshotState();

            // Create a fresh VIA and restore
            const via2 = makeUserVia();
            via2.restoreState(snapshot);

            expect(via2.ora).toBe(0x42);
            expect(via2.orb).toBe(0x37);
            expect(via2.ira).toBe(0xaa);
            expect(via2.irb).toBe(0xbb);
            expect(via2.ddra).toBe(0xf0);
            expect(via2.ddrb).toBe(0x0f);
            expect(via2.sr).toBe(0x55);
            expect(via2.acr).toBe(0x60);
            expect(via2.pcr).toBe(0x22);
            expect(via2.t1hit).toBe(false);
            expect(via2.t2hit).toBe(false);
            expect(via2.t1_pb7).toBe(1);
            expect(via2.ca1).toBe(true);
            expect(via2.cb2).toBe(true);
        });

        it("should snapshot and restore timer state", () => {
            const via = makeUserVia();
            via.t1c = 12345;
            via.t1l = 67890;
            via.t2c = 11111;
            via.t2l = 22222;

            const snapshot = via.snapshotState();
            const via2 = makeUserVia();
            via2.restoreState(snapshot);

            expect(via2.t1c).toBe(12345);
            expect(via2.t1l).toBe(67890);
            expect(via2.t2c).toBe(11111);
            expect(via2.t2l).toBe(22222);
        });

        it("should save task offset when task is scheduled", () => {
            const via = makeUserVia();
            // After reset, the via task should be scheduled
            expect(via.task.scheduled()).toBe(true);

            const snapshot = via.snapshotState();
            expect(snapshot.taskOffset).not.toBeNull();
            // Task offset should be positive (relative to epoch)
            expect(snapshot.taskOffset).toBeGreaterThan(0);
        });

        it("should save null task offset when task is not scheduled", () => {
            const via = makeUserVia();
            via.task.cancel();

            const snapshot = via.snapshotState();
            expect(snapshot.taskOffset).toBeNull();
        });

        it("should re-register task with correct offset on restore", () => {
            const via = makeUserVia();
            scheduler.polltime(1000);
            via._catchUp();

            // Set up a known timer state
            via.t1c = 500;
            via.t1l = 500;
            via.updateNextTime();

            const snapshot = via.snapshotState();
            expect(snapshot.taskOffset).not.toBeNull();
            const expectedOffset = snapshot.taskOffset;

            // Restore to a new VIA on same scheduler
            const via2 = makeUserVia();
            via2.restoreState(snapshot);

            expect(via2.task.scheduled()).toBe(true);
            // The task should expire at epoch + offset
            expect(via2.task.expireEpoch).toBe(scheduler.epoch + expectedOffset);
        });

        it("should restore interrupt state correctly", () => {
            const via = makeUserVia();
            via.ier = 0x60; // Enable timer 1 and 2 interrupts
            via.ifr = 0x40; // Timer 1 interrupt pending
            via.updateIFR();
            expect(cpu.interrupt & 0x02).toBe(0x02); // UserVia uses irq=0x02

            const snapshot = via.snapshotState();

            // Reset CPU interrupt state
            cpu.interrupt = 0;
            const via2 = makeUserVia();
            via2.restoreState(snapshot);

            // Interrupt should be re-asserted
            expect(cpu.interrupt & 0x02).toBe(0x02);
        });
    });

    describe("SysVia", () => {
        function makeSysVia() {
            return new SysVia(cpu, scheduler, {
                video: makeFakeVideo(),
                soundChip: makeFakeSoundChip(),
                cmos: makeFakeCmos(),
                isMaster: false,
                initialLayout: "physical",
            });
        }

        it("should snapshot and restore SysVia-specific fields", () => {
            const via = makeSysVia();
            // IC32 bits 6,7 control lock lights: 0 = on, 1 = off
            // Set IC32=0x23 so both lights are on (bits 6,7 clear)
            via.IC32 = 0x23;
            via.capsLockLight = true;
            via.shiftLockLight = true;

            const snapshot = via.snapshotState();
            expect(snapshot.IC32).toBe(0x23);
            expect(snapshot.capsLockLight).toBe(true);
            expect(snapshot.shiftLockLight).toBe(true);

            const via2 = makeSysVia();
            via2.restoreState(snapshot);

            expect(via2.IC32).toBe(0x23);
            // Lock lights are derived from IC32 during portBUpdated
            expect(via2.capsLockLight).toBe(true);
            expect(via2.shiftLockLight).toBe(true);
        });

        it("should include base Via fields in SysVia snapshot", () => {
            const via = makeSysVia();
            via.ora = 0x77;
            via.acr = 0x40;

            const snapshot = via.snapshotState();
            expect(snapshot.ora).toBe(0x77);
            expect(snapshot.acr).toBe(0x40);
            expect(snapshot.IC32).toBeDefined();
        });
    });
});

describe("Via CA2 write handshake", () => {
    const ORB = 0x0,
        ORA = 0x1,
        DDRB = 0x2,
        DDRA = 0x3,
        PCR = 0xc,
        ORAnh = 0xf;
    const PcrCa2Handshake = 0x08,
        PcrCa2Pulse = 0x0a;
    const SeededByte = 0x41,
        WrittenByte = 0x42;
    const PulseWidthCycles = 2;

    let via, scheduler, events;

    beforeEach(() => {
        scheduler = new Scheduler();
        via = new UserVia(makeFakeCpu(), scheduler, false, makeFakeUserPortPeripheral());
        via.write(DDRA, 0xff);
        via.write(DDRB, 0xff);
        via.write(ORAnh, SeededByte);
        events = [];
    });

    function recordCa2Changes() {
        via.ca2changecallback = (level, output) => events.push({ level, output, ora: via.ora, pins: via.portapins });
    }

    it("should present the new byte on port A before dropping CA2 in handshake mode", () => {
        via.write(PCR, PcrCa2Handshake);
        recordCa2Changes();

        via.write(ORA, WrittenByte);

        expect(events).toEqual([{ level: false, output: true, ora: WrittenByte, pins: WrittenByte }]);
    });

    it("should present the new byte on port A before pulsing CA2 in pulse mode", () => {
        via.write(PCR, PcrCa2Pulse);
        recordCa2Changes();

        via.write(ORA, WrittenByte);
        scheduler.polltime(PulseWidthCycles);

        expect(events).toEqual([
            { level: false, output: true, ora: WrittenByte, pins: WrittenByte },
            { level: true, output: true, ora: WrittenByte, pins: WrittenByte },
        ]);
    });

    it("should hold CA2 low for a cycle in pulse mode", () => {
        via.write(PCR, PcrCa2Pulse);
        recordCa2Changes();

        via.write(ORA, WrittenByte);
        expect(via.ca2).toBe(false);

        scheduler.polltime(PulseWidthCycles - 1);
        expect(via.ca2).toBe(false);

        scheduler.polltime(1);
        expect(via.ca2).toBe(true);
    });

    it("should hold CB2 low for a cycle in pulse mode", () => {
        via.write(PCR, PcrCa2Pulse << 4);
        const cb2Events = [];
        via.cb2changecallback = (level, output) => cb2Events.push({ level, output });

        via.write(ORB, WrittenByte);
        expect(cb2Events).toEqual([{ level: false, output: true }]);

        scheduler.polltime(PulseWidthCycles - 1);
        expect(via.cb2).toBe(false);

        scheduler.polltime(1);
        expect(cb2Events).toEqual([
            { level: false, output: true },
            { level: true, output: true },
        ]);
    });

    it("should carry a pulse in flight across a snapshot", () => {
        via.write(PCR, PcrCa2Pulse);
        via.write(ORA, WrittenByte);
        scheduler.polltime(PulseWidthCycles - 1);

        const restored = new UserVia(makeFakeCpu(), scheduler, false, makeFakeUserPortPeripheral());
        restored.restoreState(via.snapshotState());
        expect(restored.ca2).toBe(false);

        scheduler.polltime(1);
        expect(restored.ca2).toBe(true);
    });

    it("should not touch CA2 when writing the no-handshake register", () => {
        via.write(PCR, PcrCa2Handshake);
        recordCa2Changes();

        via.write(ORAnh, WrittenByte);

        expect(events).toEqual([]);
        expect(via.portapins).toBe(WrittenByte);
    });

    it("should leave CA2 alone when PCR selects a manual output level", () => {
        via.write(PCR, 0x0e);
        recordCa2Changes();

        via.write(ORA, WrittenByte);

        expect(events).toEqual([]);
        expect(via.portapins).toBe(WrittenByte);
    });

    it("should present the new byte on port B before dropping CB2 in handshake mode", () => {
        via.write(PCR, PcrCa2Handshake << 4);
        const cb2Events = [];
        via.cb2changecallback = (level, output) => cb2Events.push({ level, output, orb: via.orb });

        via.write(ORB, WrittenByte);

        expect(cb2Events).toEqual([{ level: false, output: true, orb: WrittenByte }]);
    });
});

function makeMockButton(pressed) {
    return { pressed };
}

function makeMockPad(buttonsState) {
    const buttons = [];
    for (let i = 0; i < 16; i++) {
        buttons[i] = makeMockButton(buttonsState[i] || false);
    }
    return { buttons };
}

describe("SysVia getJoysticks", () => {
    let scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
    });

    function makeSysViaWithGamepads(pads) {
        return new SysVia(cpu, scheduler, {
            video: makeFakeVideo(),
            soundChip: makeFakeSoundChip(),
            cmos: makeFakeCmos(),
            isMaster: false,
            initialLayout: "physical",
            getGamepads: () => pads,
        });
    }

    it("should return no buttons pressed when no gamepads connected", () => {
        const via = makeSysViaWithGamepads(null);
        const result = via.getJoysticks();
        expect(result.button1).toBe(false);
        expect(result.button2).toBe(false);
    });

    it("should detect FIRE1 (button 10) on first gamepad as button1", () => {
        const pad = makeMockPad({ 10: true });
        const via = makeSysViaWithGamepads([pad]);
        const result = via.getJoysticks();
        expect(result.button1).toBe(true);
        expect(result.button2).toBe(false);
    });

    it("should detect FIRE2 (button 11) on first gamepad as button2 with single gamepad", () => {
        const pad = makeMockPad({ 11: true });
        const via = makeSysViaWithGamepads([pad]);
        const result = via.getJoysticks();
        expect(result.button1).toBe(false);
        expect(result.button2).toBe(true);
    });

    it("should detect FIRE1 (button 10) on second gamepad as button2", () => {
        const pad1 = makeMockPad({});
        const pad2 = makeMockPad({ 10: true });
        const via = makeSysViaWithGamepads([pad1, pad2]);
        const result = via.getJoysticks();
        expect(result.button1).toBe(false);
        expect(result.button2).toBe(true);
    });

    it("should detect FIRE2 (button 11) on first gamepad as button2 even with two gamepads", () => {
        const pad1 = makeMockPad({ 11: true });
        const pad2 = makeMockPad({});
        const via = makeSysViaWithGamepads([pad1, pad2]);
        const result = via.getJoysticks();
        expect(result.button1).toBe(false);
        expect(result.button2).toBe(true);
    });

    it("should combine mouse and gamepad button states with OR logic", () => {
        const pad = makeMockPad({});
        const via = makeSysViaWithGamepads([pad]);
        via.setJoystickButton(0, true);
        const result = via.getJoysticks();
        expect(result.button1).toBe(true);
    });
});

describe("SysVia natural keyboard shift override", () => {
    let scheduler, cpu, via;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
        via = new SysVia(cpu, scheduler, {
            video: makeFakeVideo(),
            soundChip: makeFakeSoundChip(),
            cmos: makeFakeCmos(),
            isMaster: false,
            initialLayout: "natural",
        });
    });

    function bbcKeyPressed(bbcKey) {
        return via.keys[bbcKey[0]][bbcKey[1]] === 1;
    }

    it("holds no BBC shift for a `^`, which the BBC prints unshifted", () => {
        via.keyDown(keyCodes.SHIFT_LEFT, false);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(true);

        via.keyDown("^", true);
        expect(bbcKeyPressed(BBC.HAT_TILDE)).toBe(true);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(false);
    });

    it("gives the shift key back when the character is released", () => {
        via.keyDown(keyCodes.SHIFT_LEFT, false);
        via.keyDown("^", true);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(false);

        via.keyUp("^");
        expect(bbcKeyPressed(BBC.HAT_TILDE)).toBe(false);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(true);
    });

    it("keeps the shift suppressed when shift is let go first", () => {
        via.keyDown(keyCodes.SHIFT_LEFT, false);
        via.keyDown("^", true);

        via.keyUp(keyCodes.SHIFT_LEFT);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(false);

        via.keyUp("^");
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(false);
    });

    it('holds BBC shift for a `"`, which the BBC prints shifted', () => {
        via.keyDown('"', false);
        expect(bbcKeyPressed(BBC.K2)).toBe(true);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(true);
    });

    it("leaves shift alone for the space bar, which prints the same either way", () => {
        via.keyDown(" ", true);
        via.keyDown(keyCodes.SHIFT_LEFT, true);

        expect(bbcKeyPressed(BBC.SPACE)).toBe(true);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(true);
    });

    it("leaves shift alone when the host is already holding what the BBC wants", () => {
        // A `"` is shifted on both, so nothing needs correcting and nothing else should suffer.
        via.keyDown(keyCodes.SHIFT_LEFT, true);
        via.keyDown('"', true);
        via.keyDown("A", true);

        expect(bbcKeyPressed(BBC.SHIFT)).toBe(true);
        expect(bbcKeyPressed(BBC.A)).toBe(true);
    });

    it("asks for no shift either way for a plain digit", () => {
        via.keyDown("6", false);
        expect(bbcKeyPressed(BBC.K6)).toBe(true);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(false);
    });
});

describe("Via T2 clocking the shift register", () => {
    const ORB = 0x0,
        DDRB = 0x2,
        T2CL = 0x8,
        T2CH = 0x9,
        ACR = 0xb,
        IFR = 0xd,
        IER = 0xe;
    const AcrShiftOutFreeRunningT2 = 0x10;
    const AcrT2CountsPb6 = 0x20;
    const Pb6 = 0x40;
    const Timer2Int = 0x20;
    const TicksPerMicrosecond = 2;

    let via, scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
        via = new UserVia(cpu, scheduler, false, makeFakeUserPortPeripheral());
        via.write(ACR, AcrShiftOutFreeRunningT2);
    });

    function runMicroseconds(us) {
        scheduler.polltime(us * TicksPerMicrosecond);
    }

    function start(lowLatch, high) {
        via.write(T2CL, lowLatch);
        via.write(T2CH, high);
    }

    it("should decrement T2 high once per low-latch-plus-two microseconds", () => {
        const lowLatch = 10;
        start(lowLatch, 200);
        runMicroseconds(5 * (lowLatch + 2));
        expect(via.read(T2CH)).toBe(195);
    });

    it("should change rate at the next relatch when the low latch is rewritten", () => {
        start(10, 200);
        runMicroseconds(12);
        via.write(T2CL, 30);
        runMicroseconds(3 * 32);
        expect(via.read(T2CH)).toBe(196);
    });

    it("should not reload T2 high from the latch when the low byte relatches", () => {
        start(3, 1);
        runMicroseconds(3 * 5);
        expect(via.read(T2CH)).toBe(0xfe);
    });

    it("should raise the one-shot T2 interrupt only when T2 high wraps", () => {
        via.write(IER, 0x80 | Timer2Int);
        start(4, 2);
        runMicroseconds(2 * 6);
        expect(via.read(IFR) & Timer2Int).toBe(0);
        runMicroseconds(6);
        expect(via.read(IFR) & Timer2Int).toBe(Timer2Int);
        expect(cpu.interrupt).toBeTruthy();
    });

    it("should assert the interrupt when T2 high wraps without the VIA being read", () => {
        via.write(IER, 0x80 | Timer2Int);
        start(4, 2);
        runMicroseconds(3 * 6 - 1);
        expect(cpu.interrupt).toBeFalsy();
        runMicroseconds(1);
        expect(cpu.interrupt).toBeTruthy();
    });

    it("should move the interrupt when the low latch is rewritten mid-flight", () => {
        via.write(IER, 0x80 | Timer2Int);
        start(10, 1);
        via.write(T2CL, 3);
        runMicroseconds(12 + 5 - 1);
        expect(cpu.interrupt).toBeFalsy();
        runMicroseconds(1);
        expect(cpu.interrupt).toBeTruthy();
    });

    it("should time the interrupt from a count already running when shift mode is entered", () => {
        via.write(ACR, 0);
        via.write(IER, 0x80 | Timer2Int);
        start(4, 2);
        via.write(ACR, AcrShiftOutFreeRunningT2);
        runMicroseconds(3 * 6 - 1);
        expect(cpu.interrupt).toBeFalsy();
        runMicroseconds(1);
        expect(cpu.interrupt).toBeTruthy();
    });

    it("should not let an IFR write on the wrapping cycle clear the interrupt", () => {
        via.write(IER, 0x80 | Timer2Int);
        start(4, 2);
        runMicroseconds(3 * 6);
        via.write(IFR, Timer2Int);
        expect(via.read(IFR) & Timer2Int).toBe(Timer2Int);
        runMicroseconds(1);
        via.write(IFR, Timer2Int);
        expect(via.read(IFR) & Timer2Int).toBe(0);
    });

    it("should not raise the interrupt on a second wrap without a T2 high write", () => {
        via.write(IER, 0x80 | Timer2Int);
        start(4, 0);
        runMicroseconds(7);
        via.write(IFR, Timer2Int);
        runMicroseconds(257 * 6);
        expect(via.read(IFR) & Timer2Int).toBe(0);
    });

    it("should raise the interrupt again after T2 high is rewritten", () => {
        via.write(IER, 0x80 | Timer2Int);
        start(4, 0);
        runMicroseconds(7);
        expect(via.read(IFR) & Timer2Int).toBe(Timer2Int);
        via.write(T2CH, 1);
        expect(via.read(IFR) & Timer2Int).toBe(0);
        runMicroseconds(2 * 6);
        expect(via.read(IFR) & Timer2Int).toBe(Timer2Int);
    });

    it("should keep the count when leaving shift mode just after an underflow", () => {
        start(7, 5);
        runMicroseconds(9);
        expect([via.read(T2CH), via.read(T2CL)]).toEqual([4, 0xff]);
        via.write(ACR, 0);
        expect([via.read(T2CH), via.read(T2CL)]).toEqual([4, 0xff]);
    });

    it("should carry T2 high through a snapshot", () => {
        start(7, 100);
        runMicroseconds(3 * 9 + 2);
        const restored = new UserVia(cpu, scheduler, false, makeFakeUserPortPeripheral());
        restored.restoreState(via.snapshotState());
        expect([restored.read(T2CH), restored.read(T2CL)]).toEqual([via.read(T2CH), via.read(T2CL)]);
    });

    it("should split a snapshot's 16-bit count when it has no T2 high", () => {
        start(7, 100);
        runMicroseconds(3 * 9 + 2);
        const { t2High, ...older } = via.snapshotState();
        older.t2c += t2High << 9;
        const restored = new UserVia(cpu, scheduler, false, makeFakeUserPortPeripheral());
        restored.restoreState(older);
        expect([restored.read(T2CH), restored.read(T2CL)]).toEqual([via.read(T2CH), via.read(T2CL)]);
    });

    it("should not count PB6 pulses into T2 while it clocks the shift register", () => {
        via.write(ACR, AcrShiftOutFreeRunningT2 | AcrT2CountsPb6);
        start(7, 100);
        via.write(DDRB, Pb6);
        via.write(ORB, Pb6);
        const before = via.read(T2CL);
        via.write(ORB, 0);
        expect(via.read(T2CL)).toBe(before);
    });

    it("should hand the counter back to 16-bit mode on leaving shift mode", () => {
        start(7, 100);
        runMicroseconds(2);
        via.write(ACR, 0);
        expect(via.read(T2CH)).toBe(100);
        runMicroseconds(0x100);
        expect(via.read(T2CH)).toBe(99);
    });
});
