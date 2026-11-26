import { describe, expect, it, vi } from "vitest";

import { IrqSource, NmiSource } from "../../src/6502.js";
import { Midi6850 } from "../../src/midi-6850.js";
import { Scheduler } from "../../src/scheduler.js";

describe("Midi6850", () => {
    it("transmits bytes at MIDI rate and raises the transmit-empty interrupt", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: IrqSource.tube, setNmi: vi.fn() };
        const midiOutput = { sendByte: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, midiOutput, "irq", NmiSource.midi);

        midi.write(0xfc00, 0x20);
        expect(midi.peek()).toBe(0x82);
        expect(cpu.interrupt & IrqSource.midi).toBe(IrqSource.midi);
        expect(cpu.interrupt & IrqSource.tube).toBe(IrqSource.tube);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(NmiSource.midi, false);

        scheduler.polltime(123);
        midi.write(0xfc01, 0x90);
        expect(midiOutput.sendByte).toHaveBeenCalledWith(0x90, 123);
        expect(midi.peek()).toBe(0);
        expect(cpu.interrupt & IrqSource.midi).toBe(0);
        expect(cpu.interrupt & IrqSource.tube).toBe(IrqSource.tube);

        scheduler.polltime(639);
        expect(midi.peek()).toBe(0);
        scheduler.polltime(1);
        expect(midi.peek()).toBe(0x82);
        expect(cpu.interrupt & IrqSource.midi).toBe(IrqSource.midi);
    });

    it("resets the control register, transmitter and interrupt", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: 0, setNmi: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, { sendByte: vi.fn() }, "irq", NmiSource.midi);
        midi.write(0xfc00, 0x20);
        midi.write(0xfc01, 0x90);

        midi.write(0xfc00, 0x03);

        expect(midi.peek()).toBe(0x02);
        expect(cpu.interrupt & IrqSource.midi).toBe(0);
        expect(scheduler.headroom()).toBe(Scheduler.MaxHeadroom);
    });

    it("updates transmitter state without sending bytes during replay", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: 0, replaying: true, setNmi: vi.fn() };
        const midiOutput = { sendByte: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, midiOutput, "none", NmiSource.midi);

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
        const midi = new Midi6850(cpu, scheduler, 2_000_000, { sendByte: vi.fn() }, "nmi", NmiSource.midi);

        midi.write(0xfc00, 0x20);
        expect(midi.peek()).toBe(0x82);
        expect(cpu.interrupt & IrqSource.midi).toBe(0);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(NmiSource.midi, true);

        midi.write(0xfc01, 0x90);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(NmiSource.midi, false);
        scheduler.polltime(640);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(NmiSource.midi, true);
        expect(cpu.interrupt & IrqSource.midi).toBe(0);
    });

    it("leaves the interrupt pin disconnected by default", () => {
        const scheduler = new Scheduler();
        const cpu = { interrupt: 0, setNmi: vi.fn() };
        const midi = new Midi6850(cpu, scheduler, 2_000_000, { sendByte: vi.fn() }, "none", NmiSource.midi);

        midi.write(0xfc00, 0x20);

        expect(midi.peek()).toBe(0x82);
        expect(cpu.interrupt & IrqSource.midi).toBe(0);
        expect(cpu.setNmi).toHaveBeenLastCalledWith(NmiSource.midi, false);
    });

    it("restores the transmit-complete deadline", () => {
        const scheduler = new Scheduler();
        const midi = new Midi6850(
            { interrupt: 0, setNmi: vi.fn() },
            scheduler,
            2_000_000,
            { sendByte: vi.fn() },
            "none",
            NmiSource.midi,
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
            NmiSource.midi,
        );
        restored.restoreState(state);

        restoredScheduler.polltime(439);
        expect(restored.peek() & 0x02).toBe(0);
        restoredScheduler.polltime(1);
        expect(restored.peek() & 0x02).toBe(0x02);
    });
});
