"use strict";

import { IbmDiscFormat } from "./disc.js";
import {
    DensityPalette,
    DensityRampHex,
    DiscGeometry,
    ErrorHex,
    MaxDensity,
    MinDensity,
    RegionHex,
    RegionNames,
    RegionPalette,
    UnformattedHex,
    renderTracks,
    trackPulseDensity,
    trackRegions,
} from "./disc-surface.js";

/** 300 rpm, so one turn of the surface passes the head in this long. */
const RevolutionMs = 200;

/** Not on either palette: the head and the index marker have to sit clear of the surface. */
const HeadColour = "#eb6834";
const IndexColour = "#c3c2b7";
const HoverColour = "#ffffff";
/** What the panel is painted on, so a mark can be ringed clear of whatever it overlaps. */
const PanelColour = "#0d0d0d";

/**
 * Reading a whole side's format costs a couple of hundred milliseconds, so the surface is scanned
 * against a frame budget and fills in as it goes. A whole frame's worth of budget: the fill is a
 * transient, and a brief dip in frame rate beats a slow drip.
 */
const ScanBudgetMs = 16;

const Views = {
    density: {
        palette: DensityPalette,
        analyse: (track) => ({ codes: trackPulseDensity(track), sectorNumbers: null, errors: null }),
    },
    format: {
        palette: RegionPalette,
        analyse: (track, warn) => trackRegions(track, warn),
    },
};

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
     * @param {object} options.fdc - the floppy disc controller owning the drives
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

        this._onTrackWrite = (isSideUpper, trackNum) => {
            if (isSideUpper === this._isSideUpper) this._staleTracks.add(trackNum);
        };
        this._onResize = () => this._resize();
        this._onKeyDown = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                this.close();
            }
        };

        this.openBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            this.toggle();
        });
        document.getElementById("disc-close")?.addEventListener("click", () => this.close());
        this._bindChoice("[data-drive]", (button) => this._select(Number(button.dataset.drive), this._isSideUpper));
        this._bindChoice("[data-side]", (button) => this._select(this._driveIndex, button.dataset.side === "1"));
        this._bindChoice("[data-view]", (button) => this._setView(button.dataset.view));
        this.overlayCanvas.addEventListener("mousemove", (e) => {
            const rect = this.overlayCanvas.getBoundingClientRect();
            this._hover = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                scale: this.overlayCanvas.width / rect.width,
            };
        });
        this.overlayCanvas.addEventListener("mouseleave", () => (this._hover = null));
        this._buildLegend();
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
        document.addEventListener("keydown", this._onKeyDown, true);
        this._resize();
        this.update();
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.panel.hidden = true;
        this._cancelScan();
        this._detach();
        window.removeEventListener("resize", this._onResize);
        document.removeEventListener("keydown", this._onKeyDown, true);
    }

    /** Redraw whatever has moved or changed. Cheap enough to call every frame. */
    update() {
        if (!this.isOpen || !this._geometry) return;
        const disc = this._drive?.disc ?? null;
        if (this._isSideUpper && !disc?.isDoubleSided) this._select(this._driveIndex, false);
        if (disc !== this._disc) this._attach(disc);
        if (this._needsFullRepaint) this._beginFullRepaint();
        else if (this._staleTracks.size && !this._scanning) {
            for (const trackNum of this._staleTracks) this._repaintTrack(trackNum);
            this._staleTracks.clear();
            this._blit();
        }
        this._drawOverlay();
        this._updateStatus();
    }

    get _drive() {
        return this._fdc?.drives?.[this._driveIndex];
    }

    /** @returns {boolean} whether the head we would draw is over the side on show */
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
        const size = Math.round(this.surfaceCanvas.clientWidth * (window.devicePixelRatio || 1));
        if (size <= 0) return;
        for (const canvas of [this.surfaceCanvas, this.overlayCanvas]) {
            canvas.width = size;
            canvas.height = size;
        }
        this._geometry = new DiscGeometry(size, IbmDiscFormat.tracksPerDisc);
        this._imageData = this.surfaceCanvas.getContext("2d").createImageData(size, size);
        this._pixels = new Uint32Array(this._imageData.data.buffer);
        this._needsFullRepaint = true;
    }

    /** @returns {{codes: Uint8Array, sectorNumbers: Int16Array|null, errors: object[]|null}|null} */
    _analyse(trackNum) {
        const disc = this._drive?.disc;
        if (!disc) return null;
        return Views[this._view].analyse(disc.getTrack(this._isSideUpper, trackNum), () => this._warnings++);
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
        this._warnings = 0;
        this._scanCursor = 0;
        this._pixels.fill(0);
        this._advanceScan();
    }

    _cancelScan() {
        if (this._scanHandle !== null) cancelAnimationFrame(this._scanHandle);
        this._scanHandle = null;
    }

    /**
     * Scan and paint until the frame budget runs out, then pick up on the next frame. Driven by
     * requestAnimationFrame rather than the emulator's loop so it also completes while paused.
     */
    _advanceScan() {
        const count = this._geometry.numTracks;
        const deadline = performance.now() + ScanBudgetMs;
        do {
            if (this._scanCursor < count) {
                const analysis = this._analyse(this._scanCursor);
                this._codes[this._scanCursor] = analysis?.codes ?? null;
                this._info[this._scanCursor] = analysis;
            }
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

    _repaintTrack(trackNum) {
        if (trackNum >= this._geometry.numTracks) return;
        const analysis = this._analyse(trackNum);
        if (!analysis) return;
        this._codes[trackNum] = analysis.codes;
        this._info[trackNum] = analysis;
        renderTracks(this._pixels, this._geometry, this._codes, this._palette, trackNum, trackNum);
    }

    _drawOverlay() {
        const geometry = this._geometry;
        const ctx = this.overlayCanvas.getContext("2d");
        const scale = window.devicePixelRatio || 1;
        ctx.clearRect(0, 0, geometry.size, geometry.size);

        ctx.lineWidth = scale;
        ctx.strokeStyle = `${IndexColour}44`;
        ctx.beginPath();
        ctx.arc(geometry.centre, geometry.centre, geometry.outerRadius, 0, 2 * Math.PI);
        ctx.moveTo(geometry.centre + geometry.hubRadius, geometry.centre);
        ctx.arc(geometry.centre, geometry.centre, geometry.hubRadius, 0, 2 * Math.PI);
        ctx.stroke();
        this._strokeRadial(ctx, 0, `${IndexColour}66`, scale);

        this._drawErrors(ctx, scale);

        const drive = this._drive;
        if (this._showingHead) {
            const track = Math.min(drive.track, geometry.numTracks - 1);
            const fraction = drive.positionFraction;
            ctx.globalAlpha = drive.spinning ? 1 : 0.45;
            ctx.strokeStyle = `${HeadColour}55`;
            ctx.lineWidth = Math.max(geometry.trackPitch, 2 * scale);
            ctx.beginPath();
            ctx.arc(geometry.centre, geometry.centre, geometry.radiusOf(track), 0, 2 * Math.PI);
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
            ctx.arc(geometry.centre, geometry.centre, geometry.radiusOf(hover.track), 0, 2 * Math.PI);
            ctx.stroke();
        }
    }

    /**
     * CRC errors are a state, not an identity, so they are marked over the surface rather than
     * filled: a ring in the panel colour lifts the mark clear of whatever it crosses.
     */
    _drawErrors(ctx, scale) {
        const geometry = this._geometry;
        const width = Math.max(geometry.trackPitch, 2.5 * scale);
        for (let trackNum = 0; trackNum < this._info.length; ++trackNum) {
            const info = this._info[trackNum];
            if (!info?.errors?.length) continue;
            const radius = geometry.radiusOf(trackNum);
            for (const error of info.errors) {
                const start = error.firstWord / info.codes.length;
                let end = error.lastWord / info.codes.length;
                if (end <= start) end += 1;
                for (const [lineWidth, style] of [
                    [width + 3 * scale, PanelColour],
                    [width, ErrorHex],
                ]) {
                    ctx.lineWidth = lineWidth;
                    ctx.strokeStyle = style;
                    ctx.beginPath();
                    ctx.arc(geometry.centre, geometry.centre, radius, geometry.angleOf(start), geometry.angleOf(end));
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
        ctx.strokeStyle = style;
        ctx.lineWidth = scale;
        ctx.beginPath();
        ctx.moveTo(geometry.centre + geometry.innerRadius * cos, geometry.centre + geometry.innerRadius * sin);
        ctx.lineTo(geometry.centre + geometry.outerRadius * cos, geometry.centre + geometry.outerRadius * sin);
        ctx.stroke();
    }

    /** @returns {{track: number, fraction: number}|null} where the pointer is over the surface */
    _hoverPosition() {
        if (!this._hover) return null;
        return this._geometry.positionAt(this._hover.x * this._hover.scale, this._hover.y * this._hover.scale);
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
            setText(this.statusElem, `${disc.name ?? "disc"} — ${spin}, ${head}${this._scanNote()}`);
        }
        setText(this.hoverElem, this._describeHover());
    }

    _markActive(selector, isActive) {
        for (const button of this.panel.querySelectorAll(selector)) button.classList.toggle("active", isActive(button));
    }

    _scanNote() {
        if (this._scanning) return " — reading surface…";
        if (this._view !== "format") return "";
        const errors = this._info.reduce((count, info) => count + (info?.errors?.length ?? 0), 0);
        if (!errors) return "";
        return ` — ${errors} CRC error${errors === 1 ? "" : "s"}`;
    }

    _describeHover() {
        const hover = this._hoverPosition();
        if (!hover) return "Point at the surface to read it";
        const info = this._info[hover.track];
        if (!info?.codes?.length) return `Track ${hover.track} — not read yet`;
        const word = Math.min((hover.fraction * info.codes.length) | 0, info.codes.length - 1);
        const at = `Track ${hover.track} · byte ${word} of ${info.codes.length} · ${(hover.fraction * RevolutionMs).toFixed(1)} ms`;
        if (this._view !== "format") {
            const pulses = info.codes[word];
            return `${at} · ${pulses === 0 ? "no flux" : `${pulses} pulses`}`;
        }
        const sectorNumber = info.sectorNumbers[word];
        const what = RegionNames[info.codes[word]];
        const named = sectorNumber < 0 ? what : `sector ${sectorNumber} ${what}`;
        const error = info.errors.find(({ firstWord, lastWord }) =>
            lastWord <= firstWord ? word >= firstWord || word < lastWord : word >= firstWord && word < lastWord,
        );
        return `${at} · ${named}${error ? ` · ${error.kind} error` : ""}`;
    }

    _buildLegend() {
        const parts = [];
        if (this._view === "format") {
            for (let region = 0; region < RegionHex.length; ++region)
                parts.push(swatch(RegionHex[region], RegionNames[region]));
            parts.push(swatch(ErrorHex, "CRC error"));
        } else {
            parts.push(swatch(UnformattedHex, "unformatted"));
            parts.push(
                `<span class="disc-legend-item disc-legend-grow">${MinDensity}` +
                    `<span class="disc-legend-ramp" style="background:linear-gradient(to right, ${DensityRampHex.join(", ")})"></span>` +
                    `${MaxDensity} pulses per 64&micro;s</span>`,
            );
        }
        this.legendElem.innerHTML = parts.join("");
    }
}
