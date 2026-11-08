import { NoReplayHooks } from "../6502.js";
import { snapshotCycle } from "../replay.js";

const ThumbnailWidth = 160;
const ThumbnailHeight = 128;
const FramebufferWidth = 1024;
const FramebufferHeight = 625;
const VisiblePixels = FramebufferWidth * FramebufferHeight;
// As far as a preview runs if no vsync comes, as with the CRTC programmed to give none.
const LongestPreviewSeconds = 1;
const FramesPerSecond = 50;

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
 * Puts the machine at `snapshot`, one of `history`'s, and replays on from it with the inputs the host gave it then
 * (see InputLog's replay) until a complete top-to-bottom frame is in fb32. As a replay, no breakpoint or watch cuts
 * it short and nothing it prints or speaks reaches the host.
 *
 * A snapshot may be mid-frame, so it runs through two vsyncs: the first completes the partial frame and clears fb32
 * as usual; through the second, clearing is suppressed so that fb32 keeps the completed frame.
 */
export function previewFrame(history, snapshot) {
    const { cpu } = history;
    const { video } = cpu;
    let firstFrame = null;
    let secondFrame = null;
    const clear = video.clearPaintBuffer;
    const wholeFrame = () => {
        firstFrame ??= video.frameCount;
        if (secondFrame === null && video.frameCount !== firstFrame) {
            secondFrame = video.frameCount;
            video.clearPaintBuffer = () => {};
        }
        return secondFrame !== null && video.frameCount !== secondFrame;
    };
    try {
        const from = snapshotCycle(cpu, snapshot);
        history.log.replay(snapshot, from + cpu.model.cyclesPerSecond * LongestPreviewSeconds, false, {
            ...NoReplayHooks,
            instruction: wholeFrame,
        });
    } finally {
        video.clearPaintBuffer = clear;
    }
}

/**
 * Generates a thumbnail canvas for each of `snapshots`, oldest first, each previewed as `previewFrame` does. Leaves
 * the machine where the last preview ran to.
 * @param {import("../replay.js").ReplayHistory} history - whose snapshots they are
 * @param {object[]} snapshots - the snapshots, oldest first
 * @param {number} captureInterval - frames between snapshots
 * @returns {{canvas: HTMLCanvasElement, index: number, ageSeconds: number}[]}
 */
export function renderThumbnails(history, snapshots, captureInterval) {
    const { video } = history.cpu;
    return snapshots.map((snapshot, index) => {
        previewFrame(history, snapshot);
        video.renderPending();
        const stepsFromNewest = snapshots.length - 1 - index;
        const ageSeconds = Math.round((stepsFromNewest * captureInterval) / FramesPerSecond);
        return { canvas: captureThumbnail(video.fb32), index, ageSeconds };
    });
}
