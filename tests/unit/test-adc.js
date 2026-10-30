import { describe, it, expect, beforeEach, vi } from "vitest";
import { Adc, AdcCentreValue } from "../../src/adc.js";
import { Scheduler } from "../../src/scheduler.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";

const Status = 0;
const High = 1;
const Low = 2;
const Busy = 0x80;
const EndOfConversion = 0x40;
const TenBit = 0x08;
const EightBitConversionCycles = 8000;
const TenBitConversionCycles = 20000;

const source = (value) => ({ getValue: () => value, dispose: vi.fn() });

describe("Adc", () => {
    let scheduler;
    let cb1;
    let sysvia;
    let adc;

    const registers = () => [adc.read(Status), adc.read(High), adc.read(Low)];
    const convert = (control) => {
        adc.write(Status, control);
        scheduler.polltime(control & TenBit ? TenBitConversionCycles : EightBitConversionCycles);
    };

    beforeEach(() => {
        scheduler = new Scheduler();
        cb1 = null;
        sysvia = { setcb1: (level) => (cb1 = level) };
        adc = new Adc(sysvia, scheduler);
    });

    it("powers on, and resets, with a conversion complete and a zero result", () => {
        expect([...registers(), adc.read(3)]).toEqual([EndOfConversion, 0, 0, 0x40]);
        adc.setChannelSource(1, source(0x1234));
        convert(1);
        adc.reset();
        expect(registers()).toEqual([EndOfConversion, 0, 0]);
    });

    it.each([
        [0, 0x3fff, 0x00],
        [1, 0xffff, 0x30],
        [2, 0x5fff, 0x10],
        [3, 0xbfff, 0x20],
    ])("reports channel %i and its result's top two bits in the status", (channel, value, topBits) => {
        adc.setChannelSource(channel, source(value));
        convert(channel);
        expect(adc.read(Status)).toBe(channel | EndOfConversion | topBits);
    });

    it.each([4, 5, 6, 7])("answers at %i as at the register four below", (addr) => {
        adc.setChannelSource(1, source(0x1234));
        convert(1);
        expect(adc.read(addr)).toBe(adc.read(addr & 3));
    });

    it.each([1, 2, 3, 5])("starts nothing on a write to %i", (addr) => {
        adc.write(addr, 1);
        expect([adc.read(Status), cb1]).toEqual([EndOfConversion, null]);
    });

    it.each([
        ["an 8-bit", 0x02, EightBitConversionCycles],
        ["a 10-bit", TenBit | 0x03, TenBitConversionCycles],
        ["a mirrored", 0x01, EightBitConversionCycles, 4],
    ])("holds CB1 high for %s conversion's whole length", (_, control, cycles, addr = Status) => {
        adc.write(addr, control);
        expect([adc.read(Status), cb1]).toEqual([Busy | control, true]);
        scheduler.polltime(cycles - 1);
        expect(adc.read(Status) & Busy).toBe(Busy);
        scheduler.polltime(1);
        expect([adc.read(Status) & (Busy | EndOfConversion), cb1]).toEqual([EndOfConversion, false]);
    });

    it("starts again from the beginning, on the new channel, when written mid-conversion", () => {
        adc.setChannelSource(1, source(0x1234));
        adc.write(Status, 0);
        scheduler.polltime(EightBitConversionCycles - 1);
        adc.write(Status, 1);
        scheduler.polltime(EightBitConversionCycles - 1);
        expect(adc.read(Status) & Busy).toBe(Busy);
        scheduler.polltime(1);
        expect(registers().slice(1)).toEqual([0x12, 0x30]);
    });

    describe.each([
        ["8-bit", 0],
        ["10-bit", TenBit],
    ])("in %s mode", (_, precision) => {
        it.each([
            [0, 0x3fff, [0x3f, 0xf0]],
            [1, 0xffff, [0xff, 0xf0]],
            [2, 0x5a5f, [0x5a, 0x50]],
            [3, 0xdc0f, [0xdc, 0x00]],
        ])("reads channel %i from its own source, the low byte's bits 3-0 as zero", (channel, value, highLow) => {
            for (let other = 0; other < 4; other++) adc.setChannelSource(other, source(other === channel ? value : 0));
            convert(precision | channel);
            expect(registers().slice(1)).toEqual(highLow);
        });
    });

    it("reads the centre on a channel with no source", () => {
        convert(1);
        expect(registers().slice(1)).toEqual([AdcCentreValue >>> 8, AdcCentreValue & 0xff]);
    });

    it("reads a fixed value instead of the source while one is set, and the source again after", () => {
        adc.setChannelSource(1, source(0x1234));
        adc.setFixedValue(0x8000);
        convert(1);
        expect(registers().slice(1)).toEqual([0x80, 0x00]);
        adc.setFixedValue(null);
        convert(1);
        expect(registers().slice(1)).toEqual([0x12, 0x30]);
    });

    describe("sources", () => {
        it("disposes of a source when it is replaced, and not when set again", () => {
            const first = source(1);
            const second = source(2);
            adc.setChannelSource(0, first);
            adc.setChannelSource(0, first);
            expect(first.dispose).not.toHaveBeenCalled();
            adc.setChannelSource(0, second);
            expect([first.dispose.mock.calls.length, second.dispose.mock.calls.length]).toEqual([1, 0]);
        });
    });

    describe("snapshots", () => {
        it("round-trips a converter part way through its second conversion", async () => {
            await expectSnapshotRoundTrips(
                () => new Adc(sysvia, scheduler),
                (driven) => {
                    driven.setFixedValue(0x1234);
                    driven.write(Status, 1);
                    scheduler.polltime(EightBitConversionCycles);
                    driven.write(Status, TenBit | 2);
                    scheduler.polltime(100);
                },
            );
        });

        it("restores a conversion in progress with CB1 high, finishing when it would have", () => {
            adc.write(Status, 1);
            scheduler.polltime(100);
            const restoredScheduler = new Scheduler();
            let restoredCb1 = null;
            const restored = new Adc({ setcb1: (level) => (restoredCb1 = level) }, restoredScheduler);
            restored.restoreState(adc.snapshotState());
            expect(restoredCb1).toBe(true);
            restoredScheduler.polltime(EightBitConversionCycles - 101);
            expect(restored.read(Status) & Busy).toBe(Busy);
            restoredScheduler.polltime(1);
            expect([restored.read(Status) & Busy, restoredCb1]).toEqual([0, false]);
        });
    });
});
