import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelayNoise, FakeRelayNoise } from "../../src/relaynoise.js";

describe("RelayNoise", () => {
    let mockContext;
    let relayNoise;

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

        relayNoise = new RelayNoise(mockContext);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("RelayNoise class", () => {
        it("should create gain node and connect to destination", () => {
            expect(mockContext.createGain).toHaveBeenCalled();
        });

        it("should initialize with sound files", async () => {
            await relayNoise.initialise();
            expect(relayNoise.sounds).toBeDefined();
        });

        it("should play motor on sound when motorOn is called", () => {
            const mockSound = { duration: 0.05 };
            relayNoise.sounds = { motorOn: mockSound };

            relayNoise.motorOn();

            expect(mockContext.createBufferSource).toHaveBeenCalled();
        });

        it("should play motor off sound when motorOff is called", () => {
            const mockSound = { duration: 0.05 };
            relayNoise.sounds = { motorOff: mockSound };

            relayNoise.motorOff();

            expect(mockContext.createBufferSource).toHaveBeenCalled();
        });

        it("should handle mute/unmute", () => {
            const mockGain = { gain: { value: 0.25 } };
            relayNoise.gain = mockGain;

            relayNoise.mute();
            expect(mockGain.gain.value).toBe(0);

            relayNoise.unmute();
            expect(mockGain.gain.value).toBe(0.25);
        });
    });

    describe("FakeRelayNoise class", () => {
        it("should create fake implementation", () => {
            const fakeRelayNoise = new FakeRelayNoise();

            expect(() => fakeRelayNoise.initialise()).not.toThrow();
            expect(() => fakeRelayNoise.motorOn()).not.toThrow();
            expect(() => fakeRelayNoise.motorOff()).not.toThrow();
            expect(() => fakeRelayNoise.mute()).not.toThrow();
            expect(() => fakeRelayNoise.unmute()).not.toThrow();
        });

        it("should return resolved promise for initialise", async () => {
            const fakeRelayNoise = new FakeRelayNoise();
            const result = await fakeRelayNoise.initialise();
            expect(result).toBeUndefined();
        });
    });
});
