import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TapeNoise, FakeTapeNoise } from "../../src/tapenoise.js";

describe("TapeNoise", () => {
    let mockContext;
    let tapeNoise;

    beforeEach(() => {
        mockContext = {
            state: "running",
            createGain: vi.fn(() => ({
                gain: { value: 0 },
                connect: vi.fn(),
            })),
            createBufferSource: vi.fn(() => ({
                buffer: null,
                connect: vi.fn(),
                start: vi.fn(),
            })),
            destination: {},
            decodeAudioData: vi.fn((buffer, callback) => {
                // Mock decoded audio data
                const mockDecodedData = { duration: 0.05 };
                callback(mockDecodedData);
            }),
        };

        global.fetch = vi.fn(() =>
            Promise.resolve({
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
            }),
        );

        tapeNoise = new TapeNoise(mockContext);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("TapeNoise class", () => {
        it("should create gain node and connect to destination", () => {
            expect(mockContext.createGain).toHaveBeenCalled();
        });

        it("should initialize with sound files", async () => {
            await tapeNoise.initialise();
            expect(tapeNoise.sounds).toBeDefined();
        });

        it("should play motor on sound when motorOn is called", () => {
            const mockSound = { duration: 0.05 };
            tapeNoise.sounds = { motorOn: mockSound };

            tapeNoise.motorOn();

            expect(mockContext.createBufferSource).toHaveBeenCalled();
        });

        it("should play motor off sound when motorOff is called", () => {
            const mockSound = { duration: 0.05 };
            tapeNoise.sounds = { motorOff: mockSound };

            tapeNoise.motorOff();

            expect(mockContext.createBufferSource).toHaveBeenCalled();
        });

        it("should handle mute/unmute", () => {
            const mockGain = { gain: { value: 0.25 } };
            tapeNoise.gain = mockGain;

            tapeNoise.mute();
            expect(mockGain.gain.value).toBe(0);

            tapeNoise.unmute();
            expect(mockGain.gain.value).toBe(0.25);
        });
    });

    describe("FakeTapeNoise class", () => {
        it("should create fake implementation", () => {
            const fakeTapeNoise = new FakeTapeNoise();

            expect(() => fakeTapeNoise.initialise()).not.toThrow();
            expect(() => fakeTapeNoise.motorOn()).not.toThrow();
            expect(() => fakeTapeNoise.motorOff()).not.toThrow();
            expect(() => fakeTapeNoise.mute()).not.toThrow();
            expect(() => fakeTapeNoise.unmute()).not.toThrow();
        });

        it("should return resolved promise for initialise", async () => {
            const fakeTapeNoise = new FakeTapeNoise();
            const result = await fakeTapeNoise.initialise();
            expect(result).toBeUndefined();
        });
    });
});
