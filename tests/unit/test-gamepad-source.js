import { describe, it, expect, beforeEach } from "vitest";
import { GamepadSource } from "../../src/gamepad-source.js";

describe("GamepadSource", () => {
    // Mock gamepads with various axis positions
    const mockGamepads = [
        {
            axes: [0.5, -0.5, 0.25, -0.75], // pad1: right, up, slight right, mostly up
        },
        {
            axes: [-0.8, 0.3], // pad2: mostly left, slight down
        },
    ];

    let gamepadSource;

    beforeEach(() => {
        // Create a fake getGamepads function that returns our mocks
        const getGamepads = () => mockGamepads;
        gamepadSource = new GamepadSource(getGamepads);
    });

    describe("getValue", () => {
        it("should convert gamepad axis 0 value correctly", () => {
            // First axis of first gamepad is 0.5
            // Formula: Math.floor(((1 - 0.5) / 2) * 0xffff)
            // = Math.floor(0.25 * 0xffff) = 0x3fff
            const value = gamepadSource.getValue(0);
            expect(value).toBe(0x3fff);
        });

        it("should convert gamepad axis 1 value correctly", () => {
            // Second axis of first gamepad is -0.5
            // Formula: Math.floor(((1 - (-0.5)) / 2) * 0xffff)
            // = Math.floor(0.75 * 0xffff) = 0xbfff
            const value = gamepadSource.getValue(1);
            expect(value).toBe(0xbfff);
        });

        it("should use second gamepad for channel 2 if available", () => {
            // First axis of second gamepad is -0.8
            // Formula: Math.floor(((1 - (-0.8)) / 2) * 0xffff)
            // = Math.floor(0.9 * 0xffff) ≈ 58981
            const value = gamepadSource.getValue(2);
            expect(value).toBe(58981);
        });

        it("should use second gamepad for channel 3 if available", () => {
            // Second axis of second gamepad is 0.3
            // Formula: Math.floor(((1 - 0.3) / 2) * 0xffff)
            // = Math.floor(0.35 * 0xffff) ≈ 22937
            const value = gamepadSource.getValue(3);
            expect(value).toBe(22937);
        });

        it("should return center value (0x8000) when no gamepads are connected", () => {
            // Create a source that returns no gamepads
            const noGamepadsSource = new GamepadSource(() => []);
            expect(noGamepadsSource.getValue(0)).toBe(0x8000);
        });

        it("should return center value for invalid channel", () => {
            expect(gamepadSource.getValue(4)).toBe(0x8000);
            expect(gamepadSource.getValue(-1)).toBe(0x8000);
        });
    });
});
