import { describe, it, expect, beforeEach } from "vitest";
import { SysVia, UserVia } from "../../src/via.js";
import { Scheduler } from "../../src/scheduler.js";
import { BBC, keyCodes } from "../../src/keymap.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";

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
    const ORB = 0x0,
        ORA = 0x1,
        DDRB = 0x2,
        DDRA = 0x3,
        T1CL = 0x4,
        T1CH = 0x5,
        T2CL = 0x8,
        T2CH = 0x9,
        SR = 0xa,
        ACR = 0xb,
        PCR = 0xc,
        IER = 0xe;
    const AcrT1ContinuousOnPb7ShiftOutFreeRunningT2Latching = 0xd3;
    const PcrCa1Cb1RisingCa2HighCb2PulseOnWrite = 0xbf;
    const IerSetTimers = 0xe0;
    const LatchClearBit6 = 0x06,
        LatchSetBit3 = 0x0b;

    let scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
    });

    function makeUserVia() {
        return new UserVia(cpu, scheduler, false, makeFakeUserPortPeripheral());
    }

    function makeSysVia() {
        return new SysVia(cpu, scheduler, {
            video: makeFakeVideo(),
            soundChip: makeFakeSoundChip(),
            cmos: makeFakeCmos(),
            isMaster: false,
            initialLayout: "physical",
        });
    }

    function driveMidCb2PulseWithTimersRunning(via) {
        via.write(DDRA, 0xf0);
        via.write(DDRB, 0x0f);
        via.write(ACR, AcrT1ContinuousOnPb7ShiftOutFreeRunningT2Latching);
        via.write(IER, IerSetTimers);
        via.write(T1CL, 0x34);
        via.write(T1CH, 0x01);
        via.write(T2CL, 7);
        via.write(T2CH, 100);
        via.write(SR, 0x55);
        via.write(ORB, LatchClearBit6);
        scheduler.polltime(1001);
        via.write(PCR, PcrCa1Cb1RisingCa2HighCb2PulseOnWrite);
        via.setca1(true);
        via.setcb1(true);
        via.write(ORA, 0x42);
        via.write(ORB, LatchSetBit3);
        scheduler.polltime(1);
    }

    it("round-trips a user VIA mid-pulse on CB2 with its timers running", async () => {
        await expectSnapshotRoundTrips(makeUserVia, driveMidCb2PulseWithTimersRunning);
    });

    it("round-trips a system VIA with its addressable latch written, mid-pulse on CB2", async () => {
        await expectSnapshotRoundTrips(makeSysVia, driveMidCb2PulseWithTimersRunning);
    });

    it("should restore interrupt state correctly", () => {
        const via = makeUserVia();
        via.ier = 0x60; // Enable timer 1 and 2 interrupts
        via.ifr = 0x40; // Timer 1 interrupt pending
        via.updateIFR();
        expect(cpu.interrupt & 0x02).toBe(0x02); // UserVia uses irq=0x02

        const snapshot = via.snapshotState();
        cpu.interrupt = 0;
        const via2 = makeUserVia();
        via2.restoreState(snapshot);

        expect(cpu.interrupt & 0x02).toBe(0x02);
    });

    describe("SysVia keyboard", () => {
        it("hands the held keys, including a forced and a physical SHIFT, to another machine", () => {
            const via = makeSysVia();
            via.setMapped([BBC.A[0], BBC.A[1], true], 1);
            via.keyDown(keyCodes.SHIFT_LEFT, false);
            const via2 = makeSysVia();
            via2.restoreKeyboard(via.keyboardState());
            expect(via2.keys[BBC.A[0]][BBC.A[1]]).toBe(1);
            via2.setMapped([BBC.A[0], BBC.A[1], true], 0);
            expect(via2.keys[BBC.SHIFT[0]][BBC.SHIFT[1]]).toBe(1);
            via2.keyUp(keyCodes.SHIFT_LEFT);
            expect(via2.hasAnyKeyDown()).toBe(false);
        });

        it("hands over which way a held key forces SHIFT", () => {
            const via = makeSysVia();
            via.setMapped([BBC.A[0], BBC.A[1], true], 1);
            const via2 = makeSysVia();
            via2.restoreKeyboard(via.keyboardState());
            via2.setMapped(BBC.B, 1);
            expect(via2.keys[BBC.SHIFT[0]][BBC.SHIFT[1]]).toBe(1);
        });

        it("leaves the held keys alone when restoring a snapshot", () => {
            const via = makeSysVia();
            const snapshot = via.snapshotState();
            const via2 = makeSysVia();
            via2.keyDown(keyCodes.A, false);
            via2.restoreState(snapshot);
            expect(via2.keys[BBC.A[0]][BBC.A[1]]).toBe(1);
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

    it("should keep T2 running as the shift clock when the PB6 counting bit is also set", () => {
        via.write(ACR, AcrShiftOutFreeRunningT2 | AcrT2CountsPb6);
        via.write(IER, 0x80 | Timer2Int);
        start(4, 2);
        runMicroseconds(3 * 6);
        expect(cpu.interrupt).toBeTruthy();
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

describe("Via T2 toggling PB6 pulse counting", () => {
    const T2CL = 0x8,
        T2CH = 0x9,
        ACR = 0xb,
        IFR = 0xd;
    const AcrT1Continuous = 0x40;
    const AcrShiftOutFreeRunningT2 = 0x10;
    const AcrT2CountsPb6 = 0x20;
    const Timer2Int = 0x20;
    const TicksPerMicrosecond = 2;

    let via, scheduler;

    beforeEach(() => {
        scheduler = new Scheduler();
        via = new UserVia(makeFakeCpu(), scheduler, false, makeFakeUserPortPeripheral());
    });

    function runMicroseconds(us) {
        scheduler.polltime(us * TicksPerMicrosecond);
    }

    function start(low, high) {
        via.write(T2CL, low);
        via.write(T2CH, high);
    }

    it("should count PB6 held low from power-on as one pulse at the first look at the port", () => {
        const ORB = 0x0;
        const Pb6 = 0x40;
        via = new UserVia(makeFakeCpu(), scheduler, false, { read: () => 0xff & ~Pb6, write: () => {} });
        via.write(ACR, AcrT2CountsPb6);
        start(0x80, 0x10);
        const frozen = via.read(T2CL);
        via.read(ORB);
        expect(via.read(T2CL)).toBe(frozen - 1);
        via.read(ORB);
        expect(via.read(T2CL)).toBe(frozen - 1);
    });

    it("should tick T2 once more as it freezes", () => {
        start(0, 0x10);
        runMicroseconds(10);
        const running = via.read(T2CL);
        via.write(ACR, AcrT2CountsPb6);
        expect(via.read(T2CL)).toBe(running - 1);
        runMicroseconds(10);
        expect(via.read(T2CL)).toBe(running - 1);
    });

    it("should resume T2 a tick after leaving pulse counting", () => {
        via.write(ACR, AcrT2CountsPb6);
        start(0x80, 0x10);
        const frozen = via.read(T2CL);
        via.write(ACR, 0);
        runMicroseconds(1);
        expect(via.read(T2CL)).toBe(frozen);
        runMicroseconds(1);
        expect(via.read(T2CL)).toBe(frozen - 1);
    });

    it("should leave T2 alone when an ACR write keeps pulse counting", () => {
        via.write(ACR, AcrT2CountsPb6);
        start(0x80, 0x10);
        const frozen = via.read(T2CL);
        via.write(ACR, AcrT2CountsPb6 | AcrT1Continuous);
        runMicroseconds(10);
        expect(via.read(T2CL)).toBe(frozen);
    });

    it("should leave a running T2 alone when an ACR write keeps it timed", () => {
        start(0, 0x10);
        runMicroseconds(10);
        const running = via.read(T2CL);
        via.write(ACR, AcrT1Continuous);
        expect(via.read(T2CL)).toBe(running);
        runMicroseconds(1);
        expect(via.read(T2CL)).toBe(running - 1);
    });

    it("should keep a frozen count unchanged on entering shift mode under T2", () => {
        via.write(ACR, AcrT2CountsPb6);
        start(0xff, 0x00);
        expect([via.read(T2CH), via.read(T2CL)]).toEqual([0x00, 0xff]);
        via.write(ACR, AcrT2CountsPb6 | AcrShiftOutFreeRunningT2);
        expect([via.read(T2CH), via.read(T2CL)]).toEqual([0x00, 0xff]);
    });

    it("should tick T2 once more as it freezes straight from shift mode under T2", () => {
        via.write(ACR, AcrShiftOutFreeRunningT2);
        start(0x80, 0x10);
        runMicroseconds(10);
        const running = (via.read(T2CH) << 8) | via.read(T2CL);
        via.write(ACR, AcrT2CountsPb6);
        expect((via.read(T2CH) << 8) | via.read(T2CL)).toBe(running - 1);
        runMicroseconds(10);
        expect((via.read(T2CH) << 8) | via.read(T2CL)).toBe(running - 1);
    });

    it("should raise the T2 interrupt when the extra tick wraps the counter", () => {
        start(5, 0);
        runMicroseconds(6);
        expect(via.read(T2CL)).toBe(0);
        via.write(ACR, AcrT2CountsPb6);
        expect(via.read(IFR) & Timer2Int).toBe(Timer2Int);
        expect(via.read(T2CL)).toBe(0xff);
    });

    it("should not raise the T2 interrupt on the extra tick once T2 has already fired", () => {
        start(5, 0);
        runMicroseconds(7);
        via.write(IFR, Timer2Int);
        runMicroseconds(0xffff);
        expect(via.read(T2CL)).toBe(0);
        via.write(ACR, AcrT2CountsPb6);
        expect(via.read(IFR) & Timer2Int).toBe(0);
    });
});

describe("Via peek", () => {
    const ORB = 0x0,
        ORA = 0x1,
        DDRB = 0x2,
        DDRA = 0x3,
        T1CL = 0x4,
        T1CH = 0x5,
        ACR = 0xb,
        PCR = 0xc,
        IFR = 0xd,
        IER = 0xe;
    const RegisterCount = 16;
    const PcrCa1Cb1RisingEdge = 0x11;
    const AcrT1Continuous = 0x40;
    const Timer1Int = 0x40;
    const Ca1Int = 0x02;
    const Cb1Int = 0x10;
    const TicksPerMicrosecond = 2;

    let via, scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
        via = new UserVia(cpu, scheduler, false, makeFakeUserPortPeripheral());
        via.reset();
        via.write(IER, 0x80 | Timer1Int | Ca1Int | Cb1Int);
        via.write(ACR, AcrT1Continuous);
        via.write(PCR, PcrCa1Cb1RisingEdge);
        via.write(T1CL, 20);
        via.write(T1CH, 0);
    });

    function runMicroseconds(us) {
        scheduler.polltime(us * TicksPerMicrosecond);
    }

    it("gives what the next read of each register gives", () => {
        via.write(DDRA, 0x0f);
        via.write(ORA, 0x5a);
        via.write(DDRB, 0xf0);
        via.write(ORB, 0xa5);
        runMicroseconds(37);
        via.setca1(true);
        for (let reg = 0; reg < RegisterCount; ++reg) {
            const peeked = via.peek(reg);
            expect(via.read(reg)).toBe(peeked);
        }
    });

    it("sees the timer count up to the moment it is asked", () => {
        runMicroseconds(5);
        expect(via.peek(T1CL)).toBe(via.read(T1CL));
    });

    it("leaves the timer interrupt raised when peeking the timer", () => {
        runMicroseconds(25);
        expect(via.peek(T1CL)).toBe(via.read(T1CL));
        runMicroseconds(25);
        via.peek(T1CL);
        expect(via.peek(IFR) & Timer1Int).toBe(Timer1Int);
        expect(cpu.interrupt).toBeTruthy();
        via.read(T1CL);
        expect(via.peek(IFR) & Timer1Int).toBe(0);
    });

    it("leaves the port interrupts raised when peeking the ports", () => {
        via.setca1(true);
        via.setcb1(true);
        via.peek(ORA);
        via.peek(ORB);
        expect(via.peek(IFR) & (Ca1Int | Cb1Int)).toBe(Ca1Int | Cb1Int);
        via.read(ORA);
        via.read(ORB);
        expect(via.peek(IFR) & (Ca1Int | Cb1Int)).toBe(0);
    });
});
