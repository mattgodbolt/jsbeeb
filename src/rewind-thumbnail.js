"use strict";

const ThumbnailWidth = 160;
const ThumbnailHeight = 128;
const CyclesPerChunk = 8000;
// Safety limit to prevent infinite loops if video state is broken
const MaxChunks = 100;

/**
 * Render a single thumbnail canvas from a framebuffer Uint32Array.
 * Draws the 1024x625 fb32 data into a small offscreen canvas.
 * @param {Uint32Array} fb32 - the framebuffer to capture
 * @returns {HTMLCanvasElement} a small canvas with the downscaled image
 */
function captureThumbnail(fb32) {
    // fb32 may be 1024x1024 (WebGL) or 1024x625 (2D) — only copy the visible region
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = 1024;
    srcCanvas.height = 625;
    const srcCtx = srcCanvas.getContext("2d", { alpha: false });
    const imageData = srcCtx.createImageData(1024, 625);
    const visiblePixels = 1024 * 625;
    new Uint32Array(imageData.data.buffer).set(fb32.subarray(0, visiblePixels));
    srcCtx.putImageData(imageData, 0, 0);

    const thumb = document.createElement("canvas");
    thumb.width = ThumbnailWidth;
    thumb.height = ThumbnailHeight;
    const thumbCtx = thumb.getContext("2d", { alpha: false });
    thumbCtx.drawImage(srcCanvas, 0, 0, 1024, 625, 0, 0, ThumbnailWidth, ThumbnailHeight);
    return thumb;
}

/**
 * Execute cycles until the video's frameCount advances, meaning a complete
 * vsync has occurred and fb32 contains a fully-rasterised frame.
 *
 * To prevent the framebuffer being wiped after paint, we temporarily
 * suppress clearPaintBuffer so fb32 retains the completed frame for capture.
 */
function executeUntilFrame(processor, video) {
    // fb32 is NOT part of the snapshot, so it retains stale pixel data.
    // Clear it before rasterising so partial overwrites don't show old frames.
    video.fb32.fill(0xff000000); // OPAQUE_BLACK in ABGR
    const startFrame = video.frameCount;
    const origClear = video.clearPaintBuffer;
    video.clearPaintBuffer = function () {};
    try {
        for (let i = 0; i < MaxChunks; i++) {
            processor.execute(CyclesPerChunk);
            if (video.frameCount !== startFrame) return;
        }
    } finally {
        video.clearPaintBuffer = origClear;
    }
}

/**
 * Generate thumbnail canvases for all snapshots in a rewind buffer.
 *
 * While the emulator is paused:
 * 1. Saves the current state
 * 2. For each snapshot (oldest first), restores it, runs until a full
 *    frame has been rasterised, and captures a downscaled thumbnail
 * 3. Restores the original state
 *
 * @param {object} processor - the Cpu6502 instance
 * @param {object[]} snapshots - array of snapshots (oldest first)
 * @param {object} video - the Video instance (used to access fb32)
 * @param {number} captureInterval - rewind capture interval in frames (~50)
 * @returns {{canvas: HTMLCanvasElement, index: number, ageSeconds: number}[]}
 */
export function renderThumbnails(processor, snapshots, video, captureInterval) {
    if (snapshots.length === 0) return [];

    const savedState = processor.snapshotState();
    const framesPerSecond = 50;
    const results = [];

    try {
        for (let i = 0; i < snapshots.length; i++) {
            processor.restoreState(snapshots[i]);
            executeUntilFrame(processor, video);
            const canvas = captureThumbnail(video.fb32);
            const stepsFromNewest = snapshots.length - 1 - i;
            const ageSeconds = Math.round((stepsFromNewest * captureInterval) / framesPerSecond);
            results.push({ canvas, index: i, ageSeconds });
        }
    } finally {
        processor.restoreState(savedState);
    }

    return results;
}

export { ThumbnailWidth, ThumbnailHeight, executeUntilFrame };
