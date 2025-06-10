import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MouseJoystickSource } from "../../src/mouse-joystick-source.js";

describe("MouseJoystickSource", () => {
    let canvas, source, mockVia;

    beforeEach(() => {
        // Create a mock canvas element (simpler since we don't use event listeners)
        canvas = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };

        mockVia = {
            setJoystickButton: vi.fn(),
        };

        source = new MouseJoystickSource(canvas);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should initialize with center position", () => {
        expect(source.mouseX).toBe(0.5);
        expect(source.mouseY).toBe(0.5);
        expect(source.isActive).toBe(false);
    });

    it("should return center value initially", () => {
        // Mouse starts at center position (0.5, 0.5)
        // Math.floor((1 - 0.5) * 0xffff) = Math.floor(0.5 * 0xffff) = 32767
        expect(source.getValue(0)).toBe(32767);
        expect(source.getValue(1)).toBe(32767);
    });

    it("should handle mouse position tracking via API", () => {
        // Use the API method to set mouse position
        source.onMouseMove(0, 0); // top-left corner
        expect(source.isActive).toBe(true);
        expect(source.mouseX).toBe(0);
        expect(source.mouseY).toBe(0);
        expect(source.getValue(0)).toBe(0xffff); // X channel (left = max)
        expect(source.getValue(1)).toBe(0xffff); // Y channel (top = max)

        // Use the API method to move to bottom-right corner
        source.onMouseMove(1, 1); // bottom-right corner
        expect(source.mouseX).toBe(1);
        expect(source.mouseY).toBe(1);
        expect(source.getValue(0)).toBe(0); // X channel (right = min)
        expect(source.getValue(1)).toBe(0); // Y channel (bottom = min)
    });

    it("should track active state via API", () => {
        expect(source.isActive).toBe(false);

        // Using the API method sets the source as active
        source.onMouseMove(0.8, 0.3);
        expect(source.isActive).toBe(true);
        expect(source.mouseX).toBe(0.8);
        expect(source.mouseY).toBe(0.3);
    });

    it("should handle fire button clicks via API", () => {
        source.setVia(mockVia);

        // Use API method for mouse button down
        source.onMouseDown(0); // left button
        expect(mockVia.setJoystickButton).toHaveBeenCalledWith(0, true);

        // Use API method for mouse button up
        source.onMouseUp(0); // left button
        expect(mockVia.setJoystickButton).toHaveBeenCalledWith(0, false);
    });

    it("should ignore non-left mouse buttons via API", () => {
        source.setVia(mockVia);

        // Use API method with right button (button 2)
        source.onMouseDown(2);
        expect(mockVia.setJoystickButton).not.toHaveBeenCalled();
    });

    it("should return correct values for all channels", () => {
        // Use API method to set position
        source.onMouseMove(0.25, 0.75);

        expect(source.getValue(0)).toBe(Math.floor((1 - 0.25) * 0xffff)); // X channel (inverted)
        expect(source.getValue(1)).toBe(Math.floor((1 - 0.75) * 0xffff)); // Y channel (inverted)
        expect(source.getValue(2)).toBe(0x8000); // Unused channel
        expect(source.getValue(3)).toBe(0x8000); // Unused channel
        expect(source.getValue(99)).toBe(0x8000); // Invalid channel
    });

    it("should validate input range via API", () => {
        // Test boundary clamping in API method
        source.onMouseMove(-0.5, 1.5); // Out of bounds values

        // Should be clamped to valid range [0, 1]
        expect(source.mouseX).toBe(0);
        expect(source.mouseY).toBe(1);
        expect(source.getValue(0)).toBe(0xffff); // X channel (left = max)
        expect(source.getValue(1)).toBe(0); // Y channel (bottom = min)
    });

    it("should reset state on dispose", () => {
        source.setVia(mockVia);
        source.onMouseMove(0.8, 0.3);

        source.dispose();

        expect(source.via).toBe(null);
        expect(source.isActive).toBe(false);
        // No event listeners to remove since we don't register any
        expect(canvas.removeEventListener).not.toHaveBeenCalled();
    });

    it("should report enabled state correctly", () => {
        expect(source.isEnabled()).toBe(false);

        source.setVia(mockVia);
        expect(source.isEnabled()).toBe(true);

        source.setVia(null);
        expect(source.isEnabled()).toBe(false);
    });
});
