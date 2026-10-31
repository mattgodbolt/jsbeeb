import { describe, it, expect, beforeEach } from "vitest";
import { SysVia, UserVia } from "../../src/via.js";
import { Scheduler } from "../../src/scheduler.js";
import { BBC, keyCodes } from "../../src/keymap.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";
import { ViaRegister } from "./helpers.js";

const { ORB, ORA, DDRB, DDRA, T1CL, T1CH, T2CL, T2CH, SR, ACR, PCR, IFR, IER, ORAnh } = ViaRegister;
const AcrT1Continuous = 0x40;
const AcrShiftOutFreeRunningT2 = 0x10;
const AcrT2CountsPb6 = 0x20;
const Pb6 = 0x40;
const Timer1Int = 0x40;
const Timer2Int = 0x20;
const Ca2Int = 0x01;
const PcrCa2FallingEdge = 0x00;
const PcrCa2RisingEdge = 0x04;
const PcrCa2OutputLow = 0x0c;
const Ca1Int = 0x02;
const Cb1Int = 0x10;
const UserViaIrq = 0x02;
const TicksPerMicrosecond = 2;
const ScanPassTicks = 16 * TicksPerMicrosecond;

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

function makeSysVia(cpu, scheduler, { getGamepads } = {}) {
    return new SysVia(cpu, scheduler, {
        video: makeFakeVideo(),
        soundChip: makeFakeSoundChip(),
        cmos: makeFakeCmos(),
        isMaster: false,
        initialLayout: "physical",
        getGamepads,
    });
}

describe("Via snapshotState / restoreState", () => {
    const AcrT1ContinuousOnPb7ShiftOutFreeRunningT2Latching = 0xd3;
    const PcrCa1Cb1RisingCa2HighCb2PulseOnWrite = 0xbf;
    const IerSetTimers = 0xe0;
    const LatchSetBit6 = 0x0e,
        LatchSetBit3 = 0x0b,
        LatchClearBit3 = 0x03,
        LatchSetBit7 = 0x0f;

    let scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
    });

    function makeUserVia() {
        return new UserVia(cpu, scheduler, makeFakeUserPortPeripheral());
    }

    const makeSystemVia = () => makeSysVia(cpu, scheduler);

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
        via.write(ORB, LatchSetBit6);
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
        await expectSnapshotRoundTrips(makeSystemVia, driveMidCb2PulseWithTimersRunning);
    });

    it("should restore interrupt state correctly", () => {
        const via = makeUserVia();
        via.write(IER, 0x80 | Timer1Int);
        via.write(T1CL, 2);
        via.write(T1CH, 0);
        scheduler.polltime(10);
        expect(cpu.interrupt & UserViaIrq).toBe(UserViaIrq);

        const snapshot = via.snapshotState();
        cpu.interrupt = 0;
        makeUserVia().restoreState(snapshot);

        expect(cpu.interrupt & UserViaIrq).toBe(UserViaIrq);
    });

    describe("SysVia keyboard", () => {
        it("hands the held keys, including a forced and a physical SHIFT, to another machine", () => {
            const via = makeSystemVia();
            via.setMapped([BBC.A[0], BBC.A[1], true], 1);
            via.keyDown(keyCodes.SHIFT_LEFT, false);
            const via2 = makeSystemVia();
            via2.restoreKeyboard(via.keyboardState());
            expect(via2.keys[BBC.A[0]][BBC.A[1]]).toBe(1);
            via2.setMapped([BBC.A[0], BBC.A[1], true], 0);
            expect(via2.keys[BBC.SHIFT[0]][BBC.SHIFT[1]]).toBe(1);
            via2.keyUp(keyCodes.SHIFT_LEFT);
            expect(via2.hasAnyKeyDown()).toBe(false);
        });

        it("hands over which way a held key forces SHIFT", () => {
            const via = makeSystemVia();
            via.setMapped([BBC.A[0], BBC.A[1], true], 1);
            const via2 = makeSystemVia();
            via2.restoreKeyboard(via.keyboardState());
            via2.setMapped(BBC.B, 1);
            expect(via2.keys[BBC.SHIFT[0]][BBC.SHIFT[1]]).toBe(1);
            via2.setMapped([BBC.C[0], BBC.C[1], false], 1);
            via2.setMapped([BBC.C[0], BBC.C[1], false], 0);
            expect(via2.keys[BBC.SHIFT[0]][BBC.SHIFT[1]]).toBe(1);
        });

        function makeScanningVia(pcr) {
            const via = makeSystemVia();
            via.write(DDRB, 0x0f);
            via.write(ORB, LatchSetBit3);
            via.write(PCR, pcr);
            return via;
        }

        const ca2Flag = (via) => via.read(IFR) & Ca2Int;

        it.each([
            ["sets", "on the rising edge", PcrCa2RisingEdge, Ca2Int],
            ["sets", "on the falling edge", PcrCa2FallingEdge, Ca2Int],
            ["leaves clear", "an output", PcrCa2OutputLow, 0],
        ])("%s the keyboard flag on a key down while scanning, with CA2 %s", (_, __, pcr, flag) => {
            const via = makeScanningVia(pcr);
            via.keyDownRaw(BBC.A);
            expect(ca2Flag(via)).toBe(flag);
        });

        it("raises the keyboard interrupt when autoscan starts with a key held", () => {
            const via = makeSystemVia();
            via.write(DDRA, 0x7f);
            via.write(DDRB, 0x0f);
            via.write(PCR, PcrCa2RisingEdge);
            via.keyDownRaw(BBC.A);
            via.write(ORA, BBC.A[0]);
            via.write(IFR, Ca2Int);
            via.write(ORB, LatchSetBit3);
            expect(ca2Flag(via)).toBe(Ca2Int);
        });

        function expectFlagAfter(via, ticks) {
            scheduler.polltime(ticks - 1);
            expect(ca2Flag(via)).toBe(0);
            scheduler.polltime(1);
            expect(ca2Flag(via)).toBe(Ca2Int);
        }

        // The counter is on column epoch / 2 (mod 16); A is in column 1, D in column 2 and P in column 7.
        it.each([
            ["an IFR write", (via) => via.write(IFR, Ca2Int)],
            ["a port A write", (via) => via.write(ORA, 0)],
            ["a port A read", (via) => via.read(ORA)],
        ])("raises the keyboard interrupt again at the scan's next edge after %s clears it", (_, clear) => {
            const via = makeScanningVia(PcrCa2RisingEdge);
            via.keyDownRaw(BBC.A);
            clear(via);
            expectFlagAfter(via, 2);
        });

        const leaveKeys = () => {};
        const pressP = (via) => via.keyDownRaw(BBC.P);
        const releaseP = (via) => via.keyUpRaw(BBC.P);
        const OutsideKeyboardColumns = [14, 1];
        const Ca2Edge = { rising: PcrCa2RisingEdge, falling: PcrCa2FallingEdge };

        it.each([
            ["rising", "comes back round to column 1", 10, [BBC.A], leaveKeys, 24],
            ["rising", "comes back round to column 1 from mid-column", 11, [BBC.A], leaveKeys, 23],
            ["falling", "leaves column 1", 2, [BBC.A], leaveKeys, 2],
            ["falling", "comes back round and leaves column 1", 10, [BBC.A], leaveKeys, 26],
            ["rising", "reaches the first of two held columns again", 2, [BBC.A, BBC.D], leaveKeys, 32],
            ["falling", "leaves the second of two held columns", 2, [BBC.A, BBC.D], leaveKeys, 4],
            [
                "rising",
                "comes back round to column 1, past a key outside the keyboard's columns",
                10,
                [BBC.A, OutsideKeyboardColumns],
                leaveKeys,
                24,
            ],
            ["rising", "reaches a key that went down ahead of it", 10, [BBC.A], pressP, 4],
            ["falling", "leaves a key that went down ahead of it", 10, [BBC.A], pressP, 6],
            [
                "rising",
                "comes back round to column 1 once the key ahead of it goes up",
                10,
                [BBC.A, BBC.P],
                releaseP,
                24,
            ],
        ])(
            "with CA2 on the %s edge, sets the flag when the counter %s",
            (edge, _, startTicks, held, afterClear, ticks) => {
                scheduler.polltime(startTicks);
                const via = makeScanningVia(Ca2Edge[edge]);
                for (const key of held) via.keyDownRaw(key);
                via.write(IFR, Ca2Int);
                afterClear(via);
                expectFlagAfter(via, ticks);
            },
        );

        it.each([
            ["the key stays down", leaveKeys, Ca2Int],
            ["the key is released", (via) => via.keyUpRaw(BBC.A), 0],
            ["autoscan stops", (via) => via.write(ORB, LatchClearBit3), 0],
        ])("reports no CA2 level change over a scan pass when %s", (_, then, flag) => {
            const via = makeScanningVia(PcrCa2FallingEdge);
            const levels = [];
            via.ca2changecallback = (level) => levels.push(level);
            via.keyDownRaw(BBC.A);
            via.write(IFR, Ca2Int);
            then(via);
            scheduler.polltime(ScanPassTicks);
            expect(ca2Flag(via)).toBe(flag);
            expect(levels).toEqual([]);
        });

        it("raises the keyboard interrupt when a snapshot is restored with a key held that it lacked", () => {
            const snapshot = makeScanningVia(PcrCa2RisingEdge).snapshotState();
            const via = makeSystemVia();
            via.keyDownRaw(BBC.A);
            via.restoreState(snapshot);
            expect(ca2Flag(via)).toBe(Ca2Int);
        });

        it("restores a snapshot without the scan's return as having none pending", () => {
            const via = makeScanningVia(PcrCa2RisingEdge);
            via.keyDownRaw(BBC.A);
            via.write(IFR, Ca2Int);
            const { keyScanTaskOffset, ...olderSnapshot } = via.snapshotState();
            expect(keyScanTaskOffset).toBe(2);
            via.restoreState(olderSnapshot);
            scheduler.polltime(ScanPassTicks);
            expect(ca2Flag(via)).toBe(0);
        });

        it("carries the scan's return to a held key through a snapshot", () => {
            const via = makeScanningVia(PcrCa2RisingEdge);
            via.keyDownRaw(BBC.A);
            via.write(IFR, Ca2Int);
            const snapshot = via.snapshotState();
            const via2 = makeSystemVia();
            via2.restoreKeyboard(via.keyboardState());
            via2.restoreState(snapshot);
            expect(ca2Flag(via2)).toBe(0);
            scheduler.polltime(ScanPassTicks);
            expect(ca2Flag(via2)).toBe(Ca2Int);
        });

        describe("lock lights follow IC32 bits 6 (caps) and 7 (shift), lit when clear", () => {
            function latchWritten(...writes) {
                const via = makeSystemVia();
                via.write(DDRB, 0x0f);
                for (const value of writes) via.write(ORB, value);
                return via;
            }
            function restoredFrom(state) {
                const via = makeSystemVia();
                via.restoreState(state);
                return via;
            }
            it.each([
                ["at power on, with IC32 clear", () => makeSystemVia(), [true, true]],
                ["after setting bit 6", () => latchWritten(LatchSetBit6), [false, true]],
                ["after setting bit 7", () => latchWritten(LatchSetBit7), [true, false]],
                [
                    "after a reset, which leaves IC32 alone",
                    () => {
                        const via = latchWritten(LatchSetBit6, LatchSetBit7);
                        via.reset();
                        return via;
                    },
                    [false, false],
                ],
                [
                    "after restoring an older snapshot whose saved lights disagree",
                    () =>
                        restoredFrom({
                            ...latchWritten(LatchSetBit6).snapshotState(),
                            capsLockLight: true,
                            shiftLockLight: false,
                        }),
                    [false, true],
                ],
            ])("%s", (_name, makeVia, lights) => {
                const via = makeVia();
                expect([via.capsLockLight, via.shiftLockLight]).toEqual(lights);
            });
        });

        it("leaves the held keys alone when restoring a snapshot", () => {
            const via = makeSystemVia();
            const snapshot = via.snapshotState();
            const via2 = makeSystemVia();
            via2.keyDown(keyCodes.A, false);
            via2.restoreState(snapshot);
            expect(via2.keys[BBC.A[0]][BBC.A[1]]).toBe(1);
        });
    });
});

describe("Via CA2 write handshake", () => {
    const PcrCa2Handshake = 0x08,
        PcrCa2Pulse = 0x0a;
    const SeededByte = 0x41,
        WrittenByte = 0x42;
    const PulseWidthCycles = 2;

    let via, scheduler, events;

    beforeEach(() => {
        scheduler = new Scheduler();
        via = new UserVia(makeFakeCpu(), scheduler, makeFakeUserPortPeripheral());
        via.write(DDRA, 0xff);
        via.write(DDRB, 0xff);
        via.write(ORAnh, SeededByte);
        events = [];
    });

    function recordCa2Changes() {
        via.ca2changecallback = (level, output) => events.push({ level, output, ora: via.ora, pins: via.portapins });
    }

    it.each([
        ["A", "CA2", PcrCa2Handshake, ORA, "ca2changecallback", () => [via.ora, via.portapins]],
        ["B", "CB2", PcrCa2Handshake << 4, ORB, "cb2changecallback", () => [via.orb, via.portbpins]],
    ])(
        "should present the new byte on port %s before dropping %s in handshake mode",
        (_, __, pcr, register, callback, port) => {
            via.write(PCR, pcr);
            via[callback] = (level, output) => events.push({ level, output, port: port() });

            via.write(register, WrittenByte);

            expect(events).toEqual([{ level: false, output: true, port: [WrittenByte, WrittenByte] }]);
        },
    );

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

    it.each([
        ["CA2", PcrCa2Pulse, ORA, "ca2"],
        ["CB2", PcrCa2Pulse << 4, ORB, "cb2"],
    ])("should hold %s low for a cycle in pulse mode", (_, pcr, register, line) => {
        via.write(PCR, pcr);
        via[`${line}changecallback`] = (level, output) => events.push({ level, output });

        via.write(register, WrittenByte);
        expect(via[line]).toBe(false);
        expect(events).toEqual([{ level: false, output: true }]);

        scheduler.polltime(PulseWidthCycles - 1);
        expect(via[line]).toBe(false);

        scheduler.polltime(1);
        expect(via[line]).toBe(true);
        expect(events).toEqual([
            { level: false, output: true },
            { level: true, output: true },
        ]);
    });

    it("should carry a pulse in flight across a snapshot", () => {
        via.write(PCR, PcrCa2Pulse);
        via.write(ORA, WrittenByte);
        scheduler.polltime(PulseWidthCycles - 1);

        const restored = new UserVia(makeFakeCpu(), scheduler, makeFakeUserPortPeripheral());
        restored.restoreState(via.snapshotState());
        expect(restored.ca2).toBe(false);

        scheduler.polltime(1);
        expect(restored.ca2).toBe(true);
    });

    it.each([
        ["writing the no-handshake register", PcrCa2Handshake, ORAnh],
        ["PCR selects a manual output level", 0x0e, ORA],
    ])("should leave CA2 alone when %s", (_, pcr, register) => {
        via.write(PCR, pcr);
        recordCa2Changes();

        via.write(register, WrittenByte);

        expect(events).toEqual([]);
        expect(via.portapins).toBe(WrittenByte);
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

    it.each([
        ["no gamepads", null, false, [false, false]],
        ["FIRE1 on the only gamepad", [{ 10: true }], false, [true, false]],
        ["FIRE2 on the only gamepad", [{ 11: true }], false, [false, true]],
        ["FIRE1 on the second gamepad", [{}, { 10: true }], false, [false, true]],
        ["FIRE2 on the first of two gamepads", [{ 11: true }, {}], false, [false, true]],
        ["the mouse's button with an idle gamepad", [{}], true, [true, false]],
    ])("reads the fire buttons with %s", (_, pads, mouseButton, expected) => {
        const via = makeSysVia(cpu, scheduler, { getGamepads: () => pads?.map(makeMockPad) ?? null });
        if (mouseButton) via.setJoystickButton(0, true);
        const { button1, button2 } = via.getJoysticks();
        expect([button1, button2]).toEqual(expected);
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

    it("holds the BBC's shift off for a shifted `^` and gives it back on release", () => {
        via.keyDown(keyCodes.SHIFT_LEFT, false);
        via.keyDown("^", true);
        expect(bbcKeyPressed(BBC.HAT_TILDE)).toBe(true);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(false);

        via.keyUp("^");
        expect(bbcKeyPressed(BBC.HAT_TILDE)).toBe(false);
        expect(bbcKeyPressed(BBC.SHIFT)).toBe(true);
    });
});

describe("Via T2 clocking the shift register", () => {
    let via, scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
        via = new UserVia(cpu, scheduler, makeFakeUserPortPeripheral());
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

    it.each([
        ["when T2 high wraps without the VIA being read", () => start(4, 2), 3 * 6],
        [
            "moved when the low latch is rewritten mid-flight",
            () => {
                start(10, 1);
                via.write(T2CL, 3);
            },
            12 + 5,
        ],
        [
            "timed from a count already running when shift mode is entered",
            () => {
                via.write(ACR, 0);
                start(4, 2);
                via.write(ACR, AcrShiftOutFreeRunningT2);
            },
            3 * 6,
        ],
    ])("should assert the interrupt %s", (_, setUp, microseconds) => {
        via.write(IER, 0x80 | Timer2Int);
        setUp();
        runMicroseconds(microseconds - 1);
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

    it("should split a snapshot's 16-bit count when it has no T2 high", () => {
        start(7, 100);
        runMicroseconds(3 * 9 + 2);
        const { t2High, ...older } = via.snapshotState();
        older.t2c += t2High << 9;
        const restored = new UserVia(cpu, scheduler, makeFakeUserPortPeripheral());
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
    let via, scheduler;

    beforeEach(() => {
        scheduler = new Scheduler();
        via = new UserVia(makeFakeCpu(), scheduler, makeFakeUserPortPeripheral());
    });

    function runMicroseconds(us) {
        scheduler.polltime(us * TicksPerMicrosecond);
    }

    function start(low, high) {
        via.write(T2CL, low);
        via.write(T2CH, high);
    }

    it("should count PB6 held low from power-on as one pulse at the first look at the port", () => {
        via = new UserVia(makeFakeCpu(), scheduler, { read: () => 0xff & ~Pb6, write: () => {} });
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
    const PcrCa1Cb1RisingEdge = 0x11;

    let via, scheduler, cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = makeFakeCpu();
        via = new UserVia(cpu, scheduler, makeFakeUserPortPeripheral());
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

    it("gives the timers as the 16-bit values a program reads, caught up", () => {
        via.write(T1CL, 0x1e);
        via.write(T1CH, 0x4e);
        via.write(T2CL, 0x34);
        via.write(T2CH, 0x12);
        runMicroseconds(100);
        const timers = via.peekTimers();
        expect(timers.t1l).toBe(0x4e1e);
        expect(timers.t2l).toBe(0x1234);
        expect(timers.t1c).toBe(via.read(T1CL) | (via.read(T1CH) << 8));
        expect(timers.t2c).toBe(via.read(T2CL) | (via.read(T2CH) << 8));
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
