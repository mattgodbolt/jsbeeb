import { describe, expect, it } from "vitest";
import { calculateMouseCoordinates } from "../../src/mouse-coordinates.js";

/**
 * Test for mouse coordinate calculation logic.
 *
 * Issue #631: The mouse coordinate calculation in onCubMouseEvent mixed
 * evt.offsetX/offsetY (relative to event target) with container bounding-rect
 * positions. When the canvas is inset within the monitor image (e.g. display
 * filters with non-zero canvasLeft/canvasTop), this produced incorrect coordinates.
 *
 * The correct approach is to use evt.clientX/clientY against the screen canvas
 * rect directly.
 */

describe("Mouse coordinate calculation", () => {
    it("should calculate correct coordinates when canvas is inset (display filters)", () => {
        // Scenario: Canvas is inset within monitor image (e.g. CRT filter)
        // Monitor container is at viewport position (100, 50)
        // Canvas is inset by (20, 30) from the monitor edge
        // User clicks at absolute viewport position (150, 100)

        const evt = {
            clientX: 150,
            clientY: 100,
        };

        const screenRect = {
            left: 120, // cubRect.left (100) + 20 (canvas inset)
            top: 80, // cubRect.top (50) + 30 (canvas inset)
            width: 160, // Canvas is smaller than monitor
            height: 140,
        };

        const result = calculateMouseCoordinates(evt, screenRect);

        // click at (150, 100) on canvas at (120, 80) with size (160, 140)
        // x = (150-120)/160 = 0.1875, y = (100-80)/140 ≈ 0.1429
        expect(result.x).toBeCloseTo(0.1875, 4);
        expect(result.y).toBeCloseTo(0.142857, 4);
    });

    it("should calculate correct coordinates when canvas has no inset (no display filters)", () => {
        // Scenario: Canvas fills the entire monitor (no display filter)
        // Monitor and canvas have the same position and size

        const evt = {
            clientX: 150,
            clientY: 100,
        };

        const screenRect = {
            left: 100,
            top: 50,
            width: 200,
            height: 200,
        };

        const result = calculateMouseCoordinates(evt, screenRect);

        // x = (150-100)/200 = 0.25, y = (100-50)/200 = 0.25
        expect(result.x).toBeCloseTo(0.25, 4);
        expect(result.y).toBeCloseTo(0.25, 4);
    });
});
