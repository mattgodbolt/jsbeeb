/**
 * Calculate normalized mouse coordinates relative to the screen canvas.
 *
 * Uses clientX/clientY against the canvas bounding rect so that coordinates
 * are correct even when the canvas is inset within a monitor image (e.g.
 * display filters with non-zero canvasLeft/canvasTop).
 *
 * @param {MouseEvent} evt - The mouse event
 * @param {DOMRect} screenRect - Bounding client rect of the screen canvas
 * @returns {{x: number, y: number}} Normalized coordinates in [0, 1]
 */
export function calculateMouseCoordinates(evt, screenRect) {
    const x = (evt.clientX - screenRect.left) / screenRect.width;
    const y = (evt.clientY - screenRect.top) / screenRect.height;
    return { x, y };
}
