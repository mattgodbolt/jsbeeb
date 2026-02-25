import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Acia } from "../../src/acia.js";

describe("ACIA relay noise integration", () => {
    let mockCpu, mockToneGen, mockScheduler, mockRs423Handler, mockRelayNoise;
    let acia;

    beforeEach(() => {
        mockCpu = { interrupt: 0 };
        mockToneGen = { mute: vi.fn(), tone: vi.fn() };
        mockScheduler = {
            newTask: vi.fn((_fn) => ({
                cancel: vi.fn(),
                ensureScheduled: vi.fn(),
            })),
        };
        mockRs423Handler = {};
        mockRelayNoise = {
            motorOn: vi.fn(),
            motorOff: vi.fn(),
        };

        acia = new Acia(mockCpu, mockToneGen, mockScheduler, mockRs423Handler, mockRelayNoise);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("setMotor with relay noise", () => {
        it("should call relay noise motorOn when motor turns on", () => {
            acia.motorOn = false;

            acia.setMotor(true);

            expect(mockRelayNoise.motorOn).toHaveBeenCalledOnce();
            expect(acia.motorOn).toBe(true);
        });

        it("should call relay noise motorOff when motor turns off", () => {
            acia.motorOn = true;

            acia.setMotor(false);

            expect(mockRelayNoise.motorOff).toHaveBeenCalledOnce();
            expect(acia.motorOn).toBe(false);
        });

        it("should not call relay noise methods when motor state doesn't change", () => {
            acia.motorOn = true;

            acia.setMotor(true);

            expect(mockRelayNoise.motorOn).not.toHaveBeenCalled();
            expect(mockRelayNoise.motorOff).not.toHaveBeenCalled();
        });

        it("should handle missing relay noise gracefully", () => {
            const aciaWithoutRelayNoise = new Acia(mockCpu, mockToneGen, mockScheduler, mockRs423Handler, null);
            aciaWithoutRelayNoise.motorOn = false;

            expect(() => aciaWithoutRelayNoise.setMotor(true)).not.toThrow();
            expect(aciaWithoutRelayNoise.motorOn).toBe(true);
        });
    });
});
