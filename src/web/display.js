import * as canvasLib from "../canvas.js";
import { FakeVideo, Video } from "../video.js";
import { toast } from "./toast.js";

/**
 * The picture: the canvas and its filter, the video chip that paints into a
 * framebuffer of our own, and the animation frame that presents it. A stalled
 * display holds up the picture and not the emulation (issue #885).
 */
export class Display {
    constructor({
        screenCanvas,
        model,
        mode,
        tryGl = true,
        lowLatency = true,
        fakeVideo = false,
        frameSkip = 0,
        makeCanvas = (canvasEl, filterClass) =>
            tryGl
                ? canvasLib.bestCanvas(canvasEl, filterClass, lowLatency)
                : new canvasLib.Canvas(canvasEl, lowLatency),
    }) {
        this.screenCanvas = screenCanvas;
        this.frames = 0;
        this.frameSkip = frameSkip;
        this.paintMsThisTick = 0;
        this.presentMsMax = 0;
        this.presentScheduled = false;

        this.filterClass = canvasLib.getFilterForMode(mode);
        // Each mode says how many pixels it wants to draw into. Set this before
        // creating the context, which fixes its initial viewport.
        this.sizeCanvasFor(this.filterClass);
        this.canvas = makeCanvas(screenCanvas, this.filterClass);
        this.reportAnyFallback(this.filterClass);
        this.filterClass = this.canvas.filterClass;

        // The emulator paints into its own framebuffer; flyback copies the
        // finished frame into the canvas and an animation frame presents it.
        this.videoFb32 = new Uint32Array(this.canvas.fb32.length);
        this.pendingFrame = {
            minx: 0,
            miny: 0,
            maxx: 0,
            maxy: 0,
            lineBaseEven: 0,
            lineBaseOdd: 0,
            lineGrid: new Uint8Array(0),
        };

        const display = this;
        this.video = fakeVideo
            ? new FakeVideo()
            : new Video(
                  model.isMaster,
                  this.videoFb32,
                  function paint(minx, miny, maxx, maxy) {
                      display.onPaint(this, minx, miny, maxx, maxy);
                  },
                  { isAtom: model.isAtom },
              );

        this.setCrtPic();
    }

    onPaint(video, minx, miny, maxx, maxy) {
        this.frames++;
        if (this.frames < this.frameSkip) return;
        this.frames = 0;
        const start = performance.now();
        this.canvas.fb32.set(this.videoFb32.subarray(miny * 1024, maxy * 1024), miny * 1024);
        if (this.pendingFrame.lineGrid.length !== video.lineGrid.length)
            this.pendingFrame.lineGrid = new Uint8Array(video.lineGrid.length);
        this.pendingFrame.lineGrid.set(video.lineGrid);
        Object.assign(this.pendingFrame, {
            minx,
            miny,
            maxx,
            maxy,
            lineBaseEven: video.lineBaseEven,
            lineBaseOdd: video.lineBaseOdd,
        });
        this.paintMsThisTick += performance.now() - start;
        if (!this.presentScheduled) {
            this.presentScheduled = true;
            window.requestAnimationFrame(() => this.present());
        }
    }

    present() {
        this.presentScheduled = false;
        const start = performance.now();
        const { minx, miny, maxx, maxy } = this.pendingFrame;
        this.canvas.paint(minx, miny, maxx, maxy, this.pendingFrame);
        this.presentMsMax = Math.max(this.presentMsMax, performance.now() - start);
    }

    /** The mode is changed from a modal, which stops the emulator, so this repaints itself. */
    setMode(mode) {
        const newFilterClass = canvasLib.getFilterForMode(mode);
        // Everything but the filter is the same whatever the mode: the framebuffer
        // texture, the vertex buffers and fb32 all carry over untouched.
        canvasLib.useBestFilter(this.canvas, newFilterClass);
        this.reportAnyFallback(newFilterClass);
        // Follow the filter we ended up with, not the one we asked for: everything
        // downstream (the monitor picture, the canvas geometry, how large a drawing
        // buffer to ask for) comes from its display config.
        this.filterClass = this.canvas.filterClass;
        // Back to the mode's own size, undoing any scaling the last one asked for.
        this.sizeCanvasFor(this.filterClass);
        this.video.paint();
        this.setCrtPic();
        window.setTimeout(() => window.dispatchEvent(new Event("resize")), 1);
    }

    sizeCanvasFor(filterClass) {
        const displayConfig = filterClass.getDisplayConfig();
        if (
            this.screenCanvas.width === displayConfig.canvasWidth &&
            this.screenCanvas.height === displayConfig.canvasHeight
        )
            return;
        this.screenCanvas.width = displayConfig.canvasWidth;
        this.screenCanvas.height = displayConfig.canvasHeight;
    }

    // Test which filter is actually in use, not merely whether we got WebGL: a
    // filter can decline a context that works perfectly well for other modes, in
    // which case we are quietly left with an unfiltered display.
    reportAnyFallback(filterClass) {
        if (this.canvas.filterClass === filterClass) return;
        const reason = this.canvas.fallbackReason ? ` (${this.canvas.fallbackReason})` : "";
        const { name } = filterClass.getDisplayConfig();
        toast(`${name} is not available on this device, so the standard display is in use${reason}.`, {
            title: "Display",
            quietKey: "quietDisplayFallback",
        });
    }

    /** The monitor picture around the screen follows the filter in use. */
    setCrtPic() {
        const config = this.filterClass.getDisplayConfig();
        const monitorPic = document.getElementById("cub-monitor-pic");
        monitorPic.src = config.image;
        monitorPic.alt = config.imageAlt;
        monitorPic.width = config.imageWidth;
        monitorPic.height = config.imageHeight;
    }

    /** This tick's time spent copying frames out of the emulator, and start counting afresh. */
    takePaintMs() {
        const ms = this.paintMsThisTick;
        this.paintMsThisTick = 0;
        return ms;
    }

    /** The longest present since last asked, and start counting afresh. */
    takePresentMs() {
        const ms = this.presentMsMax;
        this.presentMsMax = 0;
        return ms;
    }
}
