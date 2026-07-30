import { describe, it, expect, vi, afterEach } from "vitest";
import { Acia } from "../../src/acia.js";
import { Scheduler } from "../../src/scheduler.js";

// Control register word select 101: 8 data bits, 1 stop bit, no parity.
const EightBitsOneStopNoParity = 0x14;
// Control register word select 000: 7 data bits, 2 stop bits, even parity.
const SevenBitsTwoStopEvenParity = 0x00;
const TransmitInterruptEnable = 0x20;
const Tdre = 0x02;

function createScheduledAcia(scheduler, cr, transmitRate) {
    const cpu = { interrupt: 0 };
    const acia = new Acia(cpu, { mute: vi.fn(), tone: vi.fn() }, scheduler);
    acia.write(0, cr);
    acia.setSerialTransmit(transmitRate);
    return { cpu, acia };
}

function createMockAcia(relayNoise) {
    const scheduler = {
        newTask: vi.fn(() => ({
            cancel: vi.fn(),
            ensureScheduled: vi.fn(),
            reschedule: vi.fn(),
        })),
    };
    const acia = new Acia({ interrupt: 0 }, { mute: vi.fn(), tone: vi.fn() }, scheduler, relayNoise);
    acia.setRs423Handler({});
    return acia;
}

describe("Acia", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("setMotor relay noise", () => {
        it("should trigger relay click on motor state transitions", () => {
            const relayNoise = { motorOn: vi.fn(), motorOff: vi.fn() };
            const acia = createMockAcia(relayNoise);

            acia.setMotor(true);
            expect(relayNoise.motorOn).toHaveBeenCalledOnce();
            expect(relayNoise.motorOff).not.toHaveBeenCalled();

            relayNoise.motorOn.mockClear();
            acia.setMotor(false);
            expect(relayNoise.motorOff).toHaveBeenCalledOnce();
            expect(relayNoise.motorOn).not.toHaveBeenCalled();
        });

        it("should not trigger relay click when motor state is unchanged", () => {
            const relayNoise = { motorOn: vi.fn(), motorOff: vi.fn() };
            const acia = createMockAcia(relayNoise);

            acia.setMotor(false); // already off
            expect(relayNoise.motorOn).not.toHaveBeenCalled();
            expect(relayNoise.motorOff).not.toHaveBeenCalled();

            acia.setMotor(true);
            relayNoise.motorOn.mockClear();
            acia.setMotor(true); // already on
            expect(relayNoise.motorOn).not.toHaveBeenCalled();
        });
    });

    describe("transmit timing", () => {
        // A 10 bit byte at 75 baud takes 0.1333s: 266666 cycles of the 2MHz clock.
        const ByteCyclesAt75Baud = 266666;

        const timeToEmpty = (cr, rate) => {
            const scheduler = new Scheduler();
            const { acia } = createScheduledAcia(scheduler, cr, rate);
            acia.write(1, 0x55);
            let cycles = 0;
            while (!(acia.read(0) & Tdre)) {
                scheduler.polltime(1);
                cycles++;
            }
            return cycles;
        };

        it("should empty the transmit register after one byte time", () => {
            expect(timeToEmpty(EightBitsOneStopNoParity, 75)).toBe(ByteCyclesAt75Baud);
        });

        it("should account for the word format", () => {
            // Eleven bits: start, seven data, parity, two stop.
            expect(timeToEmpty(SevenBitsTwoStopEvenParity, 75)).toBe(293333);
        });

        it("should interrupt when the transmit register empties", () => {
            const scheduler = new Scheduler();
            const { cpu, acia } = createScheduledAcia(
                scheduler,
                EightBitsOneStopNoParity | TransmitInterruptEnable,
                75,
            );
            acia.write(1, 0x55);
            expect(cpu.interrupt).toBe(0);
            scheduler.polltime(ByteCyclesAt75Baud);
            expect(cpu.interrupt).toBe(0x04);
            expect(acia.read(0) & 0x80).toBe(0x80);

            acia.write(1, 0x55);
            expect(cpu.interrupt).toBe(0);
        });

        it("should not interrupt when the transmit interrupt is disabled", () => {
            const scheduler = new Scheduler();
            const { cpu, acia } = createScheduledAcia(scheduler, EightBitsOneStopNoParity, 75);
            acia.write(1, 0x55);
            scheduler.polltime(ByteCyclesAt75Baud);
            expect(cpu.interrupt).toBe(0);
        });
    });
});
