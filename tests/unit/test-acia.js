import { describe, it, expect, vi, afterEach } from "vitest";
import { Acia } from "../../src/acia.js";

function createMockAcia(relayNoise) {
    const scheduler = {
        newTask: vi.fn(() => ({
            cancel: vi.fn(),
            ensureScheduled: vi.fn(),
            reschedule: vi.fn(),
        })),
    };
    return new Acia({ interrupt: 0 }, { mute: vi.fn(), tone: vi.fn() }, scheduler, {}, relayNoise);
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
});
