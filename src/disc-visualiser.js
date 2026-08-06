"use strict";

import { IbmDiscFormat } from "./disc.js";
import {
    DensityRampHex,
    DiscGeometry,
    MaxDensity,
    MinDensity,
    UnformattedHex,
    renderTracks,
    trackPulseDensity,
} from "./disc-surface.js";

/** 300 rpm, so one turn of the surface passes the head in this long. */
const RevolutionMs = 200;

/** Not on the density ramp: the head and the index marker have to sit clear of the surface. */
const HeadColour = "#eb6834";
const IndexColour = "#c3c2b7";
const HoverColour = "#ffffff";

/** These lines are rewritten every frame, so skip the ones that have not changed. */
function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
}

/**
 * The disc surface panel: one side of one drive's disc drawn as the physical platter, each word of
 * pulse data coloured by how many flux transitions it holds, with the head drawn where it sits.
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
        this.sideControls = document.getElementById("disc-side-controls");
        this.openBtn = document.getElementById("disc-visualiser-open");

        this.isOpen = false;
        this._driveIndex = 0;
        this._isSideUpper = false;
        this._disc = null;
        this._geometry = null;
        this._imageData = null;
        this._pixels = null;
        /** @type {(Uint8Array|null)[]} */
        this._densities = [];
        this._staleTracks = new Set();
        this._needsFullRepaint = true;
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

        this._buildLegend();
        this.openBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            this.toggle();
        });
        document.getElementById("disc-close")?.addEventListener("click", () => this.close());
        for (const button of this.panel.querySelectorAll("[data-drive]"))
            button.addEventListener("click", () => {
                this._select(Number(button.dataset.drive), this._isSideUpper);
                this.update();
            });
        for (const button of this.panel.querySelectorAll("[data-side]"))
            button.addEventListener("click", () => {
                this._select(this._driveIndex, button.dataset.side === "1");
                this.update();
            });
        this.overlayCanvas.addEventListener("mousemove", (e) => {
            const rect = this.overlayCanvas.getBoundingClientRect();
            this._hover = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                scale: this.overlayCanvas.width / rect.width,
            };
        });
        this.overlayCanvas.addEventListener("mouseleave", () => (this._hover = null));
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
        if (this._needsFullRepaint) {
            this._repaintAll();
        } else if (this._staleTracks.size) {
            for (const trackNum of this._staleTracks) this._repaintTrack(trackNum);
            this._staleTracks.clear();
            this.surfaceCanvas.getContext("2d").putImageData(this._imageData, 0, 0);
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

    _repaintAll() {
        this._needsFullRepaint = false;
        const disc = this._drive?.disc ?? null;
        this._densities = [];
        for (let trackNum = 0; trackNum < this._geometry.numTracks; ++trackNum)
            this._densities.push(disc ? trackPulseDensity(disc.getTrack(this._isSideUpper, trackNum)) : null);
        this._pixels.fill(0);
        renderTracks(this._pixels, this._geometry, this._densities, 0, this._geometry.numTracks - 1);
        this.surfaceCanvas.getContext("2d").putImageData(this._imageData, 0, 0);
    }

    _repaintTrack(trackNum) {
        const disc = this._drive?.disc;
        if (!disc || trackNum >= this._geometry.numTracks) return;
        this._densities[trackNum] = trackPulseDensity(disc.getTrack(this._isSideUpper, trackNum));
        renderTracks(this._pixels, this._geometry, this._densities, trackNum, trackNum);
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
        for (const button of this.panel.querySelectorAll("[data-drive]"))
            button.classList.toggle("active", Number(button.dataset.drive) === this._driveIndex);
        for (const button of this.panel.querySelectorAll("[data-side]"))
            button.classList.toggle("active", (button.dataset.side === "1") === this._isSideUpper);

        if (!disc) {
            setText(this.statusElem, `Drive ${this._driveIndex}: no disc`);
        } else {
            const spin = drive.spinning ? "spinning" : "stopped";
            const head = this._showingHead
                ? `head at track ${drive.track}, ${(drive.positionFraction * RevolutionMs).toFixed(1)} ms`
                : `head on the other side, track ${drive.track}`;
            setText(this.statusElem, `${disc.name ?? "disc"} — ${spin}, ${head}`);
        }
        setText(this.hoverElem, this._describeHover());
    }

    _describeHover() {
        const hover = this._hoverPosition();
        if (!hover) return "Point at the surface to read it";
        const density = this._densities[hover.track];
        if (!density?.length) return `Track ${hover.track} — unformatted`;
        const word = Math.min((hover.fraction * density.length) | 0, density.length - 1);
        const pulses = density[word];
        const state = pulses === 0 ? "no flux" : `${pulses} pulses`;
        return `Track ${hover.track} · byte ${word} of ${density.length} · ${(hover.fraction * RevolutionMs).toFixed(1)} ms · ${state}`;
    }

    _buildLegend() {
        const ramp = document.getElementById("disc-legend-ramp");
        if (ramp) {
            ramp.style.background = `linear-gradient(to right, ${DensityRampHex.join(", ")})`;
            document.getElementById("disc-legend-min").textContent = String(MinDensity);
            document.getElementById("disc-legend-max").textContent = String(MaxDensity);
        }
        const unformatted = document.getElementById("disc-legend-unformatted");
        if (unformatted) unformatted.style.background = UnformattedHex;
    }
}
