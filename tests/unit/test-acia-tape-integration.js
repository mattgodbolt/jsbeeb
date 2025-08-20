import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Acia } from "../../src/acia.js";

describe("ACIA tape noise integration", () => {
    let mockCpu, mockToneGen, mockScheduler, mockRs423Handler, mockTapeNoise;
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
        mockTapeNoise = {
            motorOn: vi.fn(),
            motorOff: vi.fn(),
        };

        acia = new Acia(mockCpu, mockToneGen, mockScheduler, mockRs423Handler, mockTapeNoise);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("setMotor with tape noise", () => {
        it("should call tape noise motorOn when motor turns on", () => {
            acia.motorOn = false;

            acia.setMotor(true);

            expect(mockTapeNoise.motorOn).toHaveBeenCalledOnce();
            expect(acia.motorOn).toBe(true);
        });

        it("should call tape noise motorOff when motor turns off", () => {
            acia.motorOn = true;

            acia.setMotor(false);

            expect(mockTapeNoise.motorOff).toHaveBeenCalledOnce();
            expect(acia.motorOn).toBe(false);
        });

        it("should not call tape noise methods when motor state doesn't change", () => {
            acia.motorOn = true;

            acia.setMotor(true);

            expect(mockTapeNoise.motorOn).not.toHaveBeenCalled();
            expect(mockTapeNoise.motorOff).not.toHaveBeenCalled();
        });

        it("should handle missing tape noise gracefully", () => {
            const aciaWithoutTapeNoise = new Acia(mockCpu, mockToneGen, mockScheduler, mockRs423Handler, null);
            aciaWithoutTapeNoise.motorOn = false;

            expect(() => aciaWithoutTapeNoise.setMotor(true)).not.toThrow();
            expect(aciaWithoutTapeNoise.motorOn).toBe(true);
        });
    });
});
