import { toast } from "./toast.js";
import { errorText } from "./reporting.js";

/** Steps the drawing buffer grows in, as a multiple of the base canvas size. */
const CanvasScaleStep = 0.25;

/**
 * Where everything goes for a given window: the monitor picture, the canvas
 * within it, and (for a mode with maxCanvasScale) how large a drawing buffer
 * to ask for. Pure, so the geometry is testable on its own.
 */
export function fitMonitor(displayConfig, viewport, canvasNative) {
    const imageOrigHeight = displayConfig.imageHeight;
    const imageOrigWidth = displayConfig.imageWidth;
    const desiredAspectRatio = imageOrigWidth / imageOrigHeight;
    const minWidth = imageOrigWidth / 4;
    const minHeight = imageOrigHeight / 4;

    let width = Math.max(minWidth, viewport.innerWidth - viewport.borderReservedSize * 2);
    let height = Math.max(minHeight, viewport.innerHeight - viewport.navbarHeight - viewport.bottomReservedSize);
    if (width / height <= desiredAspectRatio) {
        height = width / desiredAspectRatio;
    } else {
        width = height * desiredAspectRatio;
    }

    const containerScale = width / imageOrigWidth;
    const scaledVisibleWidth = displayConfig.visibleWidth * containerScale;
    const scaledVisibleHeight = displayConfig.visibleHeight * containerScale;

    const canvasAspect = canvasNative.width / canvasNative.height;
    const visibleAspect = scaledVisibleWidth / scaledVisibleHeight;

    let finalCanvasWidth, finalCanvasHeight;
    if (canvasAspect > visibleAspect) {
        finalCanvasWidth = scaledVisibleWidth;
        finalCanvasHeight = scaledVisibleWidth / canvasAspect;
    } else {
        finalCanvasHeight = scaledVisibleHeight;
        finalCanvasWidth = scaledVisibleHeight * canvasAspect;
    }

    // A mode that reconstructs detail wants to draw at the size it will be
    // seen at, up to the limit it asks for. Drawing more than the display
    // can show costs fragments and buys nothing, and for an expensive
    // shader that is the difference between comfortable and not.
    let backing = null;
    if (displayConfig.maxCanvasScale) {
        const wanted = (finalCanvasWidth * viewport.devicePixelRatio) / displayConfig.canvasWidth;
        // Quantised, because resize fires continuously while a window is
        // dragged and every distinct value reallocates the drawing buffer.
        const quantised = Math.round(wanted / CanvasScaleStep) * CanvasScaleStep;
        const scale = Math.min(displayConfig.maxCanvasScale, Math.max(1, quantised));
        backing = {
            width: Math.round(displayConfig.canvasWidth * scale),
            height: Math.round(displayConfig.canvasHeight * scale),
        };
    }

    return {
        monitor: { width, height },
        canvas: {
            width: finalCanvasWidth,
            height: finalCanvasHeight,
            left: displayConfig.canvasLeft * containerScale,
            top: displayConfig.canvasTop * containerScale,
        },
        backing,
    };
}

/** Keeps the monitor and canvas fitted to the window, and wires the page furniture around them. */
export class Layout {
    constructor({ screenCanvas, display, embed, sidebars = {} }) {
        this.screenCanvas = screenCanvas;
        this.display = display;
        this.cubMonitor = document.getElementById("cub-monitor");
        this.cubMonitorPic = document.getElementById("cub-monitor-pic");
        this.borderReservedSize = embed ? 0 : 100;
        this.bottomReservedSize = embed ? 0 : 68;
        if (embed) {
            for (const el of document.querySelectorAll(".embed-hide")) el.style.display = "none";
            document.body.style.backgroundColor = "transparent";
        }

        window.addEventListener("resize", () => this.resize());
        window.setTimeout(() => this.resize(), 1);
        window.setTimeout(() => this.resize(), 500);

        this.bindSidebar(".sidebar.left", sidebars.left, (div, img) => {
            div.style.left = -img.naturalWidth - 5 + "px";
        });
        this.bindSidebar(".sidebar.right", sidebars.right, (div, img) => {
            div.style.right = -img.naturalWidth - 5 + "px";
        });
        this.bindSidebar(".sidebar.bottom", sidebars.bottom, (div, img) => {
            div.style.bottom = -img.naturalHeight + "px";
        });

        const fullscreenItem = document.getElementById("fs");
        if (document.fullscreenEnabled) {
            fullscreenItem.addEventListener("click", async (event) => {
                event.preventDefault();
                try {
                    await screenCanvas.requestFullscreen();
                } catch (error) {
                    toast(`Could not go fullscreen: ${errorText(error)}`, { title: "Fullscreen" });
                }
            });
        } else {
            fullscreenItem.closest("li").hidden = true;
        }
    }

    resize() {
        // The display config can change when the display mode switches.
        const displayConfig = this.display.filterClass.getDisplayConfig();
        const fitted = fitMonitor(
            displayConfig,
            {
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                navbarHeight: document.getElementById("header-bar")?.offsetHeight || 0,
                borderReservedSize: this.borderReservedSize,
                bottomReservedSize: this.bottomReservedSize,
                devicePixelRatio: window.devicePixelRatio || 1,
            },
            { width: this.screenCanvas.getAttribute("width"), height: this.screenCanvas.getAttribute("height") },
        );

        this.cubMonitor.style.height = fitted.monitor.height + "px";
        this.cubMonitor.style.width = fitted.monitor.width + "px";
        this.cubMonitorPic.style.height = fitted.monitor.height + "px";
        this.cubMonitorPic.style.width = fitted.monitor.width + "px";

        if (fitted.backing && this.screenCanvas.width !== fitted.backing.width) {
            this.screenCanvas.width = fitted.backing.width;
            this.screenCanvas.height = fitted.backing.height;
            // Resizing threw the drawing buffer away.
            this.display.video.paint();
        }

        this.screenCanvas.style.width = fitted.canvas.width + "px";
        this.screenCanvas.style.height = fitted.canvas.height + "px";
        this.screenCanvas.style.left = fitted.canvas.left + "px";
        this.screenCanvas.style.top = fitted.canvas.top + "px";
    }

    bindSidebar(selector, url, onload) {
        const div = document.querySelector(selector);
        const img = div.querySelector("img");
        img.style.display = "none";
        if (!url) return;
        img.addEventListener("load", () => {
            onload(div, img);
            img.style.display = "";
        });
        img.src = url;
    }
}
