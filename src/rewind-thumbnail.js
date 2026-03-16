"use strict";

const ThumbnailWidth = 160;
const ThumbnailHeight = 128;
const FramebufferWidth = 1024;
const FramebufferHeight = 625;
const VisiblePixels = FramebufferWidth * FramebufferHeight;
const CyclesPerChunk = 8000;
// Safety limit to prevent infinite loops if video state is broken
const MaxChunks = 100;

// Reusable offscreen canvas and ImageData for captureThumbnail to avoid
// allocating a full 1024x625 buffer per thumbnail.
let srcCanvas = null;
let srcCtx = null;
let srcImageData = null;

function ensureSrcCanvas() {
    if (srcCanvas) return;
    srcCanvas = document.createElement("canvas");
    srcCanvas.width = FramebufferWidth;
    srcCanvas.height = FramebufferHeight;
    srcCtx = srcCanvas.getContext("2d", { alpha: false });
    srcImageData = srcCtx.createImageData(FramebufferWidth, FramebufferHeight);
}

/**
 * Render a single thumbnail canvas from a framebuffer Uint32Array.
 * Reuses a shared offscreen canvas for the full-size copy, then
 * downscales into a new small canvas for the thumbnail.
 * @param {Uint32Array} fb32 - the framebuffer to capture
 * @returns {HTMLCanvasElement} a small canvas with the downscaled image
 */
function captureThumbnail(fb32) {
    ensureSrcCanvas();
    // fb32 may be 1024x1024 (WebGL) or 1024x625 (2D) — only copy the visible region
    new Uint32Array(srcImageData.data.buffer).set(fb32.subarray(0, VisiblePixels));
    srcCtx.putImageData(srcImageData, 0, 0);

    const thumb = document.createElement("canvas");
    thumb.width = ThumbnailWidth;
    thumb.height = ThumbnailHeight;
    const thumbCtx = thumb.getContext("2d", { alpha: false });
    thumbCtx.drawImage(srcCanvas, 0, 0, FramebufferWidth, FramebufferHeight, 0, 0, ThumbnailWidth, ThumbnailHeight);
    return thumb;
}

/**
 * Execute cycles until a complete top-to-bottom frame is in fb32.
 *
 * Snapshots may be mid-frame, so we run through two vsyncs:
 * 1. First vsync completes the partial frame and clears fb32 normally.
 * 2. Second vsync rasterises a full frame; we suppress clearPaintBuffer
 *    so fb32 retains the completed frame for capture.
 */
function executeUntilFrame(processor, video) {
    const startFrame = video.frameCount;

    // Phase 1: run to first vsync (completes partial frame, clears fb32)
    for (let i = 0; i < MaxChunks; i++) {
        if (processor.execute(CyclesPerChunk) === false) break;
        if (video.frameCount !== startFrame) break;
    }

    // Phase 2: run to second vsync with clear suppressed (full frame in fb32)
    const secondFrame = video.frameCount;
    const origClear = video.clearPaintBuffer;
    video.clearPaintBuffer = function () {};
    try {
        for (let i = 0; i < MaxChunks; i++) {
            if (processor.execute(CyclesPerChunk) === false) return;
            if (video.frameCount !== secondFrame) return;
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
 * @param {object} [savedState] - pre-saved state to restore after rendering (avoids double snapshot)
 * @returns {{canvas: HTMLCanvasElement, index: number, ageSeconds: number}[]}
 */
export function renderThumbnails(processor, snapshots, video, captureInterval, savedState) {
    if (snapshots.length === 0) return [];

    if (!savedState) savedState = processor.snapshotState();
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

export { executeUntilFrame };
