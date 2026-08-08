"use strict";

import { IbmDiscFormat } from "./disc.js";
import {
    DensityPalette,
    DensityRampHex,
    DiscGeometry,
    ErrorHex,
    MaxDensity,
    MinDensity,
    RegionStyles,
    RegionPalette,
    UnformattedHex,
    clampZoom,
    renderTracks,
    trackPulseDensity,
    trackRegions,
} from "./disc-surface.js";

/** 300 rpm. */
const RevolutionMs = 200;

/** Not on either palette: the head and the index marker have to sit clear of the surface. */
const HeadColour = "#eb6834";
const IndexColour = "#c3c2b7";
const HoverColour = "#ffffff";
const MarkOutline = "#0d0d0d";

const ScanBudgetMs = 16;

/** A trackpad reports deltas in the tens, a mouse notch about 100. */
const WheelZoomRate = 0.003;

/** Firefox reports wheel deltas in lines, not pixels. */
const PixelsPerWheelLine = 16;

const Views = {
    density: {
        palette: DensityPalette,
        analyse: (track) => ({ codes: trackPulseDensity(track) }),
        describe: ({ codes }, word) => (codes[word] === 0 ? "no flux" : `${codes[word]} pulses`),
        legend: () =>
            swatch(UnformattedHex, "unformatted") +
            `<span class="disc-legend-item disc-legend-grow">${MinDensity}` +
            `<span class="disc-legend-ramp" style="background:linear-gradient(to right, ${DensityRampHex.join(", ")})"></span>` +
            `${MaxDensity} pulses per 64&micro;s</span>`,
    },
    format: {
        palette: RegionPalette,
        analyse: (track, warn) => trackRegions(track, warn),
        describe: ({ codes, sectorNumbers, errors }, word) => {
            const what = RegionStyles[codes[word]].name;
            const named = sectorNumbers[word] < 0 ? what : `sector ${sectorNumbers[word]} ${what}`;
            const error = errors.find(({ firstWord, lastWord }) =>
                lastWord <= firstWord ? word >= firstWord || word < lastWord : word >= firstWord && word < lastWord,
            );
            return `${named}${error ? ` · ${error.kind} error` : ""}`;
        },
        legend: () => RegionStyles.map(({ hex, name }) => swatch(hex, name)).join("") + swatch(ErrorHex, "CRC error"),
    },
};

const ignoreWarning = () => {};

/** These lines are rewritten every frame, so skip the ones that have not changed. */
function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
}

/** One atomic legend entry, so a swatch never gets orphaned from its label by a line break. */
function swatch(colour, label) {
    return `<span class="disc-legend-item"><span class="disc-legend-swatch" style="background:${colour}"></span>${label}</span>`;
}

/**
 * The disc surface panel: one side of one drive's disc drawn as the physical platter, coloured
 * either by raw pulse density or by what the decoder makes of each word, with the head drawn
 * where it sits.
 */
export class DiscVisualiser {
    /**
     * @param {object} options
     * @param {object} options.fdc
     */
    constructor({ fdc }) {
        this._fdc = fdc;
        this.panel = document.getElementById("disc-panel");
        this.surfaceCanvas = document.getElementById("disc-surface");
        this.overlayCanvas = document.getElementById("disc-overlay");
        this.statusElem = document.getElementById("disc-status");
        this.hoverElem = document.getElementById("disc-hover");
        this.legendElem = document.getElementById("disc-legend");
        this.sideControls = document.getElementById("disc-side-controls");
        this.openBtn = document.getElementById("disc-visualiser-open");

        this.isOpen = false;
        this._view = "density";
        this._driveIndex = 0;
        this._isSideUpper = false;
        this._disc = null;
        this._geometry = null;
        this._imageData = null;
        this._pixels = null;
        /** @type {(Uint8Array|null)[]} */
        this._codes = [];
        /** @type {(object|null)[]} */
        this._info = [];
        this._staleTracks = new Set();
        this._needsFullRepaint = true;
        this._scanCursor = 0;
        this._scanHandle = null;
        this._hover = null;
        this._position = null;
        this._pan = null;
        this._drag = null;
        this._surfaceStale = false;
        this._frameHandle = null;

        this._onTrackWrite = (isSideUpper, trackNum) => {
            if (isSideUpper === this._isSideUpper) this._staleTracks.add(trackNum);
        };
        this._onResize = () => this._resize();
        this.openBtn.addEventListener("click", (e) => {
            e.preventDefault();
            this.toggle();
        });
        document.getElementById("disc-close").addEventListener("click", () => this.close());
        this._bindChoice("[data-drive]", (button) => this._select(Number(button.dataset.drive), this._isSideUpper));
        this._bindChoice("[data-side]", (button) => this._select(this._driveIndex, button.dataset.side === "1"));
        this._bindChoice("[data-view]", (button) => this._setView(button.dataset.view));
        this.overlayCanvas.addEventListener("mousemove", (e) => (this._hover = this._canvasPoint(e)));
        this.overlayCanvas.addEventListener("mouseleave", () => (this._hover = null));
        this._bindZoomAndPan();
        this._bindDrag(this.panel.querySelector(".disc-header"));
        this._buildLegend();
    }

    _bindZoomAndPan() {
        const canvas = this.overlayCanvas;
        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            if (!this._geometry) return;
            const { x, y } = this._canvasPoint(e);
            const at = this._geometry.toDisc(x, y);
            const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? PixelsPerWheelLine : 1;
            const zoom = clampZoom(this._geometry.zoom * Math.exp(-e.deltaY * lines * WheelZoomRate));
            // Keep whatever is under the pointer under the pointer.
            this._setViewport(zoom, at.x - x / zoom, at.y - y / zoom);
        });
        canvas.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            const { originX, originY } = this._geometry;
            this._pan = { pointerId: e.pointerId, ...this._canvasPoint(e), originX, originY, moved: false };
            canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener("pointermove", (e) => {
            if (this._pan?.pointerId !== e.pointerId) return;
            const { x, y } = this._canvasPoint(e);
            const { zoom } = this._geometry;
            this._pan.moved = true;
            this._setViewport(
                zoom,
                this._pan.originX - (x - this._pan.x) / zoom,
                this._pan.originY - (y - this._pan.y) / zoom,
            );
        });
        for (const ending of ["pointerup", "pointercancel"])
            canvas.addEventListener(ending, (e) => {
                if (this._pan?.pointerId !== e.pointerId) return;
                if (this._pan.moved) this._surfaceStale = true;
                this._pan = null;
            });
        canvas.addEventListener("dblclick", () => this._setViewport(1, 0, 0));
    }

    /** @returns {{x: number, y: number}} the event's position in canvas pixels */
    _canvasPoint(e) {
        const rect = this.overlayCanvas.getBoundingClientRect();
        const scale = this.overlayCanvas.width / rect.width;
        return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
    }

    _setViewport(zoom, originX, originY) {
        const was = { ...this._geometry };
        this._geometry.setView(zoom, originX, originY);
        if (
            was.zoom !== this._geometry.zoom ||
            was.originX !== this._geometry.originX ||
            was.originY !== this._geometry.originY
        )
            this._surfaceStale = true;
    }

    _bindDrag(header) {
        header.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || e.target.closest("button")) return;
            const { left, top } = this.panel.getBoundingClientRect();
            this._drag = { pointerId: e.pointerId, grabX: e.clientX - left, grabY: e.clientY - top };
            header.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        header.addEventListener("pointermove", (e) => {
            if (this._drag?.pointerId !== e.pointerId) return;
            this._moveTo(e.clientX - this._drag.grabX, e.clientY - this._drag.grabY);
        });
        for (const ending of ["pointerup", "pointercancel"])
            header.addEventListener(ending, (e) => {
                if (this._drag?.pointerId === e.pointerId) this._drag = null;
            });
    }

    _moveTo(left, top) {
        const { width, height } = this.panel.getBoundingClientRect();
        this._position = {
            left: Math.min(Math.max(left, 0), Math.max(0, window.innerWidth - width)),
            top: Math.min(Math.max(top, 0), Math.max(0, window.innerHeight - height)),
        };
        this.panel.style.left = `${this._position.left}px`;
        this.panel.style.top = `${this._position.top}px`;
        // Dragging trades the panel's right-hand anchor for an explicit position.
        this.panel.style.right = "auto";
    }

    _bindChoice(selector, onClick) {
        for (const button of this.panel.querySelectorAll(selector))
            button.addEventListener("click", () => {
                onClick(button);
                this.update();
            });
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        this.panel.hidden = false;
        window.addEventListener("resize", this._onResize);
        this._resize();
        this._tick();
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.panel.hidden = true;
        if (this._frameHandle !== null) cancelAnimationFrame(this._frameHandle);
        this._frameHandle = null;
        this._cancelScan();
        this._detach();
        this._hover = null;
        this._needsFullRepaint = true;
        window.removeEventListener("resize", this._onResize);
    }

    _tick() {
        this.update();
        this._frameHandle = requestAnimationFrame(() => this._tick());
    }

    /** Cheap enough to call every frame. */
    update() {
        if (!this.isOpen || !this._geometry) return;
        const disc = this._drive?.disc ?? null;
        if (this._isSideUpper && !disc?.isDoubleSided) this._select(this._driveIndex, false);
        if (disc !== this._disc) this._attach(disc);
        if (this._needsFullRepaint) this._beginFullRepaint();
        else if (this._surfaceStale) this._repaintSurface();
        else if (this._staleTracks.size && !this._scanning) this._repaintStaleTracks();
        this._drawOverlay();
        this._updateStatus();
    }

    get _drive() {
        return this._fdc.drives[this._driveIndex];
    }

    get _showingHead() {
        const drive = this._drive;
        return !!drive?.disc && drive.isSideUpper === this._isSideUpper;
    }

    get _scanning() {
        return this._geometry !== null && this._scanCursor <= this._geometry.numTracks;
    }

    _setView(view) {
        if (view === this._view || !Views[view]) return;
        this._view = view;
        this._needsFullRepaint = true;
        this._buildLegend();
    }

    _select(driveIndex, isSideUpper) {
        if (driveIndex === this._driveIndex && isSideUpper === this._isSideUpper) return;
        this._driveIndex = driveIndex;
        this._isSideUpper = isSideUpper;
        this._detach();
        this._needsFullRepaint = true;
    }

    _attach(disc) {
        this._detach();
        this._disc = disc;
        disc?.addTrackWriteListener(this._onTrackWrite);
        this._needsFullRepaint = true;
    }

    _detach() {
        this._disc?.removeTrackWriteListener(this._onTrackWrite);
        this._disc = null;
        this._staleTracks.clear();
    }

    _resize() {
        if (this._position) this._moveTo(this._position.left, this._position.top);
        const size = Math.round(this.surfaceCanvas.clientWidth * (window.devicePixelRatio || 1));
        if (size <= 0 || size === this._geometry?.size) return;
        for (const canvas of [this.surfaceCanvas, this.overlayCanvas]) {
            canvas.width = size;
            canvas.height = size;
        }
        const previous = this._geometry;
        this._geometry = new DiscGeometry(size, IbmDiscFormat.tracksPerDisc);
        if (previous) this._geometry.adoptView(previous);
        this._imageData = this.surfaceCanvas.getContext("2d").createImageData(size, size);
        this._pixels = new Uint32Array(this._imageData.data.buffer);
        this._needsFullRepaint = true;
    }

    /** @returns {{codes: Uint8Array, sectorNumbers: Int16Array|null, errors: object[]|null}|null} */
    _analyse(trackNum) {
        if (!this._disc) return null;
        return Views[this._view].analyse(this._disc.getTrack(this._isSideUpper, trackNum), ignoreWarning);
    }

    _blit() {
        this.surfaceCanvas.getContext("2d").putImageData(this._imageData, 0, 0);
    }

    _beginFullRepaint() {
        this._needsFullRepaint = false;
        this._cancelScan();
        const count = this._geometry.numTracks;
        this._codes = new Array(count).fill(null);
        this._info = new Array(count).fill(null);
        this._scanCursor = 0;
        this._pixels.fill(0);
        this._advanceScan();
    }

    _cancelScan() {
        if (this._scanHandle !== null) cancelAnimationFrame(this._scanHandle);
        this._scanHandle = null;
    }

    /** Driven by requestAnimationFrame rather than the emulator's loop, so it completes while paused. */
    _advanceScan() {
        const count = this._geometry.numTracks;
        const deadline = performance.now() + ScanBudgetMs;
        do {
            if (this._scanCursor < count) this._analyseInto(this._scanCursor);
            // A track's edge pixels sample its neighbours, so paint one behind the scan.
            const paintTrack = this._scanCursor - 1;
            if (paintTrack >= 0)
                renderTracks(this._pixels, this._geometry, this._codes, this._palette, paintTrack, paintTrack);
            this._scanCursor++;
        } while (this._scanCursor <= count && performance.now() < deadline);
        this._blit();
        if (this._scanning) this._scanHandle = requestAnimationFrame(() => this._advanceScan());
        else this._scanHandle = null;
    }

    get _palette() {
        return Views[this._view].palette;
    }

    _repaintStaleTracks() {
        const deadline = performance.now() + ScanBudgetMs;
        for (const trackNum of this._staleTracks) {
            this._repaintTrack(trackNum);
            this._staleTracks.delete(trackNum);
            if (performance.now() >= deadline) break;
        }
        this._blit();
    }

    /** For when the view moved rather than the disc. */
    _repaintSurface() {
        this._surfaceStale = false;
        this._pixels.fill(0);
        // Mid-drag the whole surface is redrawn every frame, so trade smoothed edges for the frame rate.
        const supersample = this._pan ? 1 : undefined;
        const last = this._geometry.numTracks - 1;
        renderTracks(this._pixels, this._geometry, this._codes, this._palette, 0, last, supersample);
        this._blit();
    }

    _analyseInto(trackNum) {
        const analysis = this._analyse(trackNum);
        this._info[trackNum] = analysis;
        this._codes[trackNum] = analysis?.codes ?? null;
    }

    _repaintTrack(trackNum) {
        if (trackNum >= this._geometry.numTracks) return;
        this._analyseInto(trackNum);
        renderTracks(this._pixels, this._geometry, this._codes, this._palette, trackNum, trackNum);
    }

    _drawOverlay() {
        const geometry = this._geometry;
        const ctx = this.overlayCanvas.getContext("2d");
        const scale = window.devicePixelRatio || 1;
        ctx.clearRect(0, 0, geometry.size, geometry.size);

        const centreX = geometry.screenCentreX;
        const centreY = geometry.screenCentreY;
        ctx.lineWidth = scale;
        ctx.strokeStyle = `${IndexColour}44`;
        ctx.beginPath();
        ctx.arc(centreX, centreY, geometry.outerRadius * geometry.zoom, 0, 2 * Math.PI);
        ctx.moveTo(centreX + geometry.hubRadius * geometry.zoom, centreY);
        ctx.arc(centreX, centreY, geometry.hubRadius * geometry.zoom, 0, 2 * Math.PI);
        ctx.stroke();
        this._strokeRadial(ctx, 0, `${IndexColour}66`, scale);

        this._drawErrors(ctx, scale);

        const drive = this._drive;
        if (this._showingHead) {
            const track = Math.min(drive.track, geometry.numTracks - 1);
            const fraction = drive.positionFraction;
            ctx.globalAlpha = drive.spinning ? 1 : 0.45;
            ctx.strokeStyle = `${HeadColour}55`;
            ctx.lineWidth = Math.max(geometry.trackPitch * geometry.zoom, 2 * scale);
            ctx.beginPath();
            ctx.arc(centreX, centreY, geometry.screenRadiusOf(track), 0, 2 * Math.PI);
            ctx.stroke();
            this._strokeRadial(ctx, fraction, `${HeadColour}66`, scale);
            const { x, y } = geometry.pointAt(track, fraction);
            ctx.fillStyle = HeadColour;
            ctx.beginPath();
            ctx.arc(x, y, 3.5 * scale, 0, 2 * Math.PI);
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        const hover = this._hoverPosition();
        if (hover) {
            ctx.strokeStyle = `${HoverColour}55`;
            ctx.lineWidth = scale;
            ctx.beginPath();
            ctx.arc(centreX, centreY, geometry.screenRadiusOf(hover.track), 0, 2 * Math.PI);
            ctx.stroke();
        }
    }

    _drawErrors(ctx, scale) {
        const geometry = this._geometry;
        const width = Math.max(geometry.trackPitch * geometry.zoom, 2.5 * scale);
        for (let trackNum = 0; trackNum < this._info.length; ++trackNum) {
            const info = this._info[trackNum];
            if (!info?.errors?.length) continue;
            const radius = geometry.screenRadiusOf(trackNum);
            for (const error of info.errors) {
                const start = error.firstWord / info.codes.length;
                let end = error.lastWord / info.codes.length;
                if (end <= start) end += 1;
                for (const [lineWidth, style] of [
                    [width + 3 * scale, MarkOutline],
                    [width, ErrorHex],
                ]) {
                    ctx.lineWidth = lineWidth;
                    ctx.strokeStyle = style;
                    ctx.beginPath();
                    ctx.arc(
                        geometry.screenCentreX,
                        geometry.screenCentreY,
                        radius,
                        geometry.angleOf(start),
                        geometry.angleOf(end),
                    );
                    ctx.stroke();
                }
            }
        }
    }

    _strokeRadial(ctx, fraction, style, scale) {
        const geometry = this._geometry;
        const angle = geometry.angleOf(fraction);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const inner = geometry.innerRadius * geometry.zoom;
        const outer = geometry.outerRadius * geometry.zoom;
        ctx.strokeStyle = style;
        ctx.lineWidth = scale;
        ctx.beginPath();
        ctx.moveTo(geometry.screenCentreX + inner * cos, geometry.screenCentreY + inner * sin);
        ctx.lineTo(geometry.screenCentreX + outer * cos, geometry.screenCentreY + outer * sin);
        ctx.stroke();
    }

    /** @returns {{track: number, fraction: number}|null} */
    _hoverPosition() {
        return this._hover ? this._geometry.positionAt(this._hover.x, this._hover.y) : null;
    }

    _updateStatus() {
        const drive = this._drive;
        const disc = drive?.disc;
        this.sideControls.hidden = !disc?.isDoubleSided;
        this._markActive("[data-drive]", (button) => Number(button.dataset.drive) === this._driveIndex);
        this._markActive("[data-side]", (button) => (button.dataset.side === "1") === this._isSideUpper);
        this._markActive("[data-view]", (button) => button.dataset.view === this._view);

        if (!disc) {
            setText(this.statusElem, `Drive ${this._driveIndex}: no disc`);
        } else {
            const head = this._showingHead
                ? `head at track ${drive.track}, ${(drive.positionFraction * RevolutionMs).toFixed(1)} ms`
                : `head on the other side, track ${drive.track}`;
            const spin = drive.spinning ? "spinning" : "stopped";
            const zoom = this._geometry.zoom > 1 ? ` · ${this._geometry.zoom.toFixed(1)}x` : "";
            setText(this.statusElem, `${disc.name ?? "disc"} · ${spin}, ${head}${zoom}${this._scanNote()}`);
        }
        setText(this.hoverElem, this._describeHover());
    }

    _markActive(selector, isActive) {
        for (const button of this.panel.querySelectorAll(selector)) button.classList.toggle("active", isActive(button));
    }

    _scanNote() {
        if (this._scanning) return " · reading surface…";
        const errors = this._info.reduce((count, info) => count + (info?.errors?.length ?? 0), 0);
        if (!errors) return "";
        return ` · ${errors} CRC error${errors === 1 ? "" : "s"}`;
    }

    _describeHover() {
        const hover = this._hoverPosition();
        if (!hover) return "Point at the surface to read it";
        const info = this._info[hover.track];
        if (!info?.codes?.length) return `Track ${hover.track} · not read yet`;
        const word = Math.min((hover.fraction * info.codes.length) | 0, info.codes.length - 1);
        const at = `Track ${hover.track} · word ${word} of ${info.codes.length} · ${(hover.fraction * RevolutionMs).toFixed(1)} ms`;
        return `${at} · ${Views[this._view].describe(info, word)}`;
    }

    _buildLegend() {
        this.legendElem.innerHTML = Views[this._view].legend();
    }
}
