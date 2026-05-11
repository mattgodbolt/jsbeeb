import { describe, expect, it } from "vitest";

/**
 * Test for mouse coordinate calculation logic.
 *
 * Issue #631: The mouse coordinate calculation in onCubMouseEvent mixes
 * evt.offsetX/offsetY (relative to event target) with container bounding-rect
 * positions. When the canvas is inset within the monitor image (e.g. display
 * filters with non-zero canvasLeft/canvasTop), this produces incorrect coordinates.
 *
 * The correct approach is to use evt.clientX/clientY against the screen canvas
 * rect directly.
 */

/**
 * Simulates the CURRENT (buggy) coordinate calculation from main.js lines 541-542
 */
function calculateCoordinatesBuggy(evt, cubRect, screenRect, screenCanvas) {
    const x = (evt.offsetX - cubRect.left + screenRect.left) / screenCanvas.offsetWidth;
    const y = (evt.offsetY - cubRect.top + screenRect.top) / screenCanvas.offsetHeight;
    return { x, y };
}

/**
 * Simulates the CORRECT coordinate calculation using clientX/Y
 */
function calculateCoordinatesCorrect(evt, screenRect) {
    const x = (evt.clientX - screenRect.left) / screenRect.width;
    const y = (evt.clientY - screenRect.top) / screenRect.height;
    return { x, y };
}

describe("Mouse coordinate calculation", () => {
    it("should fail with buggy calculation when canvas is inset (display filters)", () => {
        // Scenario: Canvas is inset within monitor image (e.g. CRT filter)
        // Monitor container is at viewport position (100, 50)
        // Canvas is inset by (20, 30) from the monitor edge
        // User clicks at absolute viewport position (150, 100)

        const evt = {
            offsetX: 50, // Relative to cubMonitor
            offsetY: 50, // Relative to cubMonitor
            clientX: 150, // Absolute viewport position
            clientY: 100, // Absolute viewport position
        };

        const cubRect = {
            left: 100,
            top: 50,
            width: 200,
            height: 200,
        };

        const screenRect = {
            left: 120, // cubRect.left + 20 (canvas inset)
            top: 80, // cubRect.top + 30 (canvas inset)
            width: 160, // Canvas is smaller than monitor
            height: 140,
        };

        const screenCanvas = {
            offsetWidth: 160,
            offsetHeight: 140,
        };

        // Expected: click at (150, 100) on canvas at (120, 80) with size (160, 140)
        // Should give normalized coords: x = (150-120)/160 = 0.1875, y = (100-80)/140 = 0.1429
        const expected = {
            x: (evt.clientX - screenRect.left) / screenRect.width,
            y: (evt.clientY - screenRect.top) / screenRect.height,
        };

        const buggy = calculateCoordinatesBuggy(evt, cubRect, screenRect, screenCanvas);
        const correct = calculateCoordinatesCorrect(evt, screenRect);

        // The buggy calculation should NOT match the expected result
        expect(buggy.x).not.toBeCloseTo(expected.x, 4);
        expect(buggy.y).not.toBeCloseTo(expected.y, 4);

        // The correct calculation SHOULD match
        expect(correct.x).toBeCloseTo(expected.x, 4);
        expect(correct.y).toBeCloseTo(expected.y, 4);
    });

    it("should work correctly when canvas has no inset (no display filters)", () => {
        // Scenario: Canvas fills the entire monitor (no display filter)
        // Monitor and canvas have the same position and size

        const evt = {
            offsetX: 50,
            offsetY: 50,
            clientX: 150,
            clientY: 100,
        };

        const cubRect = {
            left: 100,
            top: 50,
            width: 200,
            height: 200,
        };

        const screenRect = {
            left: 100, // Same as cubRect (no inset)
            top: 50, // Same as cubRect (no inset)
            width: 200,
            height: 200,
        };

        const screenCanvas = {
            offsetWidth: 200,
            offsetHeight: 200,
        };

        const expected = {
            x: (evt.clientX - screenRect.left) / screenRect.width,
            y: (evt.clientY - screenRect.top) / screenRect.height,
        };

        const buggy = calculateCoordinatesBuggy(evt, cubRect, screenRect, screenCanvas);
        const correct = calculateCoordinatesCorrect(evt, screenRect);

        // In this case, the buggy calculation happens to work (by accident)
        // because cubRect and screenRect have the same position
        expect(buggy.x).toBeCloseTo(expected.x, 4);
        expect(buggy.y).toBeCloseTo(expected.y, 4);

        // The correct calculation also works
        expect(correct.x).toBeCloseTo(expected.x, 4);
        expect(correct.y).toBeCloseTo(expected.y, 4);
    });
});
