import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MouseJoystickSource } from "../../src/mouse-joystick-source.js";

describe("MouseJoystickSource", () => {
    let canvas, source, mockVia;
    let originalDocument;

    beforeEach(() => {
        // Mock document if it doesn't exist
        originalDocument = globalThis.document;
        if (!globalThis.document) {
            globalThis.document = {
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            };
        }

        // Create a mock canvas element
        canvas = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            getBoundingClientRect: vi.fn(() => ({
                left: 100,
                top: 100,
                width: 800,
                height: 600,
            })),
        };

        mockVia = {
            setJoystickButton: vi.fn(),
        };

        source = new MouseJoystickSource(canvas);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        // Restore original document
        if (originalDocument) {
            globalThis.document = originalDocument;
        } else {
            delete globalThis.document;
        }
    });

    it("should initialize with center position", () => {
        expect(source.mouseX).toBe(0.5);
        expect(source.mouseY).toBe(0.5);
        expect(source.isActive).toBe(false);
    });

    it("should attach event listeners to canvas", () => {
        expect(canvas.addEventListener).toHaveBeenCalledWith("mousemove", expect.any(Function));
        expect(canvas.addEventListener).toHaveBeenCalledWith("mouseenter", expect.any(Function));
        expect(canvas.addEventListener).toHaveBeenCalledWith("mouseleave", expect.any(Function));
        expect(canvas.addEventListener).toHaveBeenCalledWith("mousedown", expect.any(Function));
        expect(canvas.addEventListener).toHaveBeenCalledWith("mouseup", expect.any(Function));
    });

    it("should attach global mouse move listener", () => {
        expect(document.addEventListener).toHaveBeenCalledWith("mousemove", expect.any(Function));
    });

    it("should return center value initially", () => {
        // Mouse starts at center position (0.5, 0.5)
        // Math.floor((1 - 0.5) * 0xffff) = Math.floor(0.5 * 0xffff) = 32767
        expect(source.getValue(0)).toBe(32767);
        expect(source.getValue(1)).toBe(32767);
    });

    it("should handle mouse position tracking", () => {
        // Simulate mouse enter
        source.handleMouseEnter();
        expect(source.isActive).toBe(true);

        // Simulate mouse move to top-left corner
        const mockEvent = {
            clientX: 100, // left edge
            clientY: 100, // top edge
        };
        source.handleMouseMove(mockEvent);

        expect(source.mouseX).toBe(0);
        expect(source.mouseY).toBe(0);
        expect(source.getValue(0)).toBe(0xffff); // X channel (left = max)
        expect(source.getValue(1)).toBe(0xffff); // Y channel (top = max)

        // Simulate mouse move to bottom-right corner
        mockEvent.clientX = 900; // right edge (100 + 800)
        mockEvent.clientY = 700; // bottom edge (100 + 600)
        source.handleMouseMove(mockEvent);

        expect(source.mouseX).toBe(1);
        expect(source.mouseY).toBe(1);
        expect(source.getValue(0)).toBe(0); // X channel (right = min)
        expect(source.getValue(1)).toBe(0); // Y channel (bottom = min)
    });

    it("should handle mouse leave properly", () => {
        source.handleMouseEnter();
        source.mouseX = 0.8;
        source.mouseY = 0.3;

        source.handleMouseLeave();

        expect(source.isActive).toBe(false);
        // Position should remain unchanged when mouse leaves
        expect(source.mouseX).toBe(0.8);
        expect(source.mouseY).toBe(0.3);
    });

    it("should handle fire button clicks", () => {
        source.setVia(mockVia);
        source.handleMouseEnter();

        // Simulate left mouse button down
        const downEvent = { button: 0, preventDefault: vi.fn() };
        source.handleMouseDown(downEvent);

        expect(mockVia.setJoystickButton).toHaveBeenCalledWith(0, true);
        expect(downEvent.preventDefault).toHaveBeenCalled();

        // Simulate left mouse button up
        const upEvent = { button: 0, preventDefault: vi.fn() };
        source.handleMouseUp(upEvent);

        expect(mockVia.setJoystickButton).toHaveBeenCalledWith(0, false);
        expect(upEvent.preventDefault).toHaveBeenCalled();
    });

    it("should ignore non-left mouse buttons", () => {
        source.setVia(mockVia);
        source.handleMouseEnter();

        const rightClickEvent = { button: 2, preventDefault: vi.fn() };
        source.handleMouseDown(rightClickEvent);

        expect(mockVia.setJoystickButton).not.toHaveBeenCalled();
        expect(rightClickEvent.preventDefault).not.toHaveBeenCalled();
    });

    it("should return correct values for all channels", () => {
        source.handleMouseEnter();
        source.mouseX = 0.25;
        source.mouseY = 0.75;

        expect(source.getValue(0)).toBe(Math.floor((1 - 0.25) * 0xffff)); // X channel (inverted)
        expect(source.getValue(1)).toBe(Math.floor((1 - 0.75) * 0xffff)); // Y channel (inverted)
        expect(source.getValue(2)).toBe(0x8000); // Unused channel
        expect(source.getValue(3)).toBe(0x8000); // Unused channel
        expect(source.getValue(99)).toBe(0x8000); // Invalid channel
    });

    it("should track mouse position globally", () => {
        const mockEvent = {
            clientX: 300, // 200 pixels to the right of canvas left edge
            clientY: 250, // 150 pixels below canvas top edge
        };

        source.handleGlobalMouseMove(mockEvent);

        // Expected: x = 200/800 = 0.25, y = 150/600 = 0.25
        expect(source.mouseX).toBe(0.25);
        expect(source.mouseY).toBe(0.25);
        expect(source.getValue(0)).toBe(Math.floor((1 - 0.25) * 0xffff)); // Inverted
        expect(source.getValue(1)).toBe(Math.floor((1 - 0.25) * 0xffff)); // Inverted
    });

    it("should remove event listeners on dispose", () => {
        source.dispose();

        expect(canvas.removeEventListener).toHaveBeenCalledWith("mousemove", expect.any(Function));
        expect(canvas.removeEventListener).toHaveBeenCalledWith("mouseenter", expect.any(Function));
        expect(canvas.removeEventListener).toHaveBeenCalledWith("mouseleave", expect.any(Function));
        expect(canvas.removeEventListener).toHaveBeenCalledWith("mousedown", expect.any(Function));
        expect(canvas.removeEventListener).toHaveBeenCalledWith("mouseup", expect.any(Function));
        expect(document.removeEventListener).toHaveBeenCalledWith("mousemove", expect.any(Function));
    });
});
