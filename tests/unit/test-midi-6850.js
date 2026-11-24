import { describe, expect, it, vi } from "vitest";

import { Midi6850 } from "../../src/midi-6850.js";
import { Scheduler } from "../../src/scheduler.js";

describe("Midi6850", () => {
    it("transmits bytes at MIDI rate and raises the transmit-empty interrupt", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: 0x08, setNmi: vi.fn() };
        const midiOutput = { sendByte: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, midiOutput, "irq", 0x08);

        midi.write(0xfc00, 0x20);
        expect(midi.peek()).toBe(0x82);
        expect(cpu.interrupt & 0x10).toBe(0x10);
        expect(cpu.interrupt & 0x08).toBe(0x08);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(0x08, false);

        scheduler.polltime(123);
        midi.write(0xfc01, 0x90);
        expect(midiOutput.sendByte).toHaveBeenCalledWith(0x90, 123);
        expect(midi.peek()).toBe(0);
        expect(cpu.interrupt & 0x10).toBe(0);
        expect(cpu.interrupt & 0x08).toBe(0x08);

        scheduler.polltime(639);
        expect(midi.peek()).toBe(0);
        scheduler.polltime(1);
        expect(midi.peek()).toBe(0x82);
        expect(cpu.interrupt & 0x10).toBe(0x10);
    });

    it("resets the control register, transmitter and interrupt", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: 0, setNmi: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, { sendByte: vi.fn() }, "irq", 0x08);
        midi.write(0xfc00, 0x20);
        midi.write(0xfc01, 0x90);

        midi.write(0xfc00, 0x03);

        expect(midi.peek()).toBe(0x02);
        expect(cpu.interrupt & 0x10).toBe(0);
        expect(scheduler.headroom()).toBe(Scheduler.MaxHeadroom);
    });

    it("updates transmitter state without sending bytes during replay", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: 0, replaying: true, setNmi: vi.fn() };
        const midiOutput = { sendByte: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, midiOutput, "none", 0x08);

        midi.write(0xfc01, 0x90);

        expect(midi.data).toBe(0x90);
        expect(midi.peek(0xfc00)).toBe(0);
        expect(midiOutput.sendByte).not.toHaveBeenCalled();

        scheduler.polltime(639);
        expect(midi.peek(0xfc00)).toBe(0);
        scheduler.polltime(1);
        expect(midi.peek(0xfc00)).toBe(0x02);
    });

    it("routes the transmit-empty interrupt to NMI without asserting IRQ", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: 0, setNmi: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, { sendByte: vi.fn() }, "nmi", 0x08);

        midi.write(0xfc00, 0x20);
        expect(midi.peek()).toBe(0x82);
        expect(cpu.interrupt & 0x10).toBe(0);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(0x08, true);

        midi.write(0xfc01, 0x90);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(0x08, false);
        scheduler.polltime(640);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(0x08, true);
        expect(cpu.interrupt & 0x10).toBe(0);
    });

    it("leaves the interrupt pin disconnected by default", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: 0, setNmi: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, { sendByte: vi.fn() }, "none", 0x08);

        midi.write(0xfc00, 0x20);

        expect(midi.peek()).toBe(0x82);
        expect(cpu.interrupt & 0x10).toBe(0);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(0x08, false);
    });

    it("restores the transmit-complete deadline", () => {
        const scheduler = new Scheduler();
        const midi = new Midi6850(
            { interrupt: 0, setNmi: vi.fn() },
            scheduler,
            2_000_000,
            { sendByte: vi.fn() },
            "none",
            0x08,
        );
        midi.write(0xfc01, 0x90);
        scheduler.polltime(200);
        const state = midi.snapshotState();

        const restoredScheduler = new Scheduler();
        restoredScheduler.restoreState(scheduler.snapshotState());
        const restored = new Midi6850(
            { interrupt: 0, setNmi: vi.fn() },
            restoredScheduler,
            2_000_000,
            { sendByte: vi.fn() },
            "none",
            0x08,
        );
        restored.restoreState(state);

        restoredScheduler.polltime(439);
        expect(restored.peek() & 0x02).toBe(0);
        restoredScheduler.polltime(1);
        expect(restored.peek() & 0x02).toBe(0x02);
    });
});
