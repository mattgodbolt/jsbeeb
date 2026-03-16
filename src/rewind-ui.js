"use strict";

import { renderThumbnails, executeUntilFrame } from "./rewind-thumbnail.js";

/**
 * Rewind scrubber UI — a filmstrip overlay showing thumbnails of recent
 * emulator states, allowing the user to click to restore any of them.
 */
export class RewindUI {
    /**
     * @param {object} options
     * @param {object} options.rewindBuffer - RewindBuffer instance
     * @param {object} options.processor - Cpu6502 instance
     * @param {object} options.video - Video instance
     * @param {number} options.captureInterval - rewind capture interval in frames
     * @param {function} options.stop - function to pause the emulator
     * @param {function} options.go - function to resume the emulator
     * @param {function} options.isRunning - function returning current running state
     */
    constructor({ rewindBuffer, processor, video, captureInterval, stop, go, isRunning }) {
        this.rewindBuffer = rewindBuffer;
        this.processor = processor;
        this.video = video;
        this.captureInterval = captureInterval;
        this.stop = stop;
        this.go = go;
        this.isRunning = isRunning;

        this.panel = document.getElementById("rewind-panel");
        this.filmstrip = document.getElementById("rewind-filmstrip");
        this.closeBtn = document.getElementById("rewind-close");
        this.openBtn = document.getElementById("rewind-open");

        this.isOpen = false;
        this.wasRunning = false;
        this.selectedIndex = -1;
        this.snapshots = [];
        this.savedState = null;

        this._onKeyDown = this._onKeyDown.bind(this);
        this.closeBtn.addEventListener("click", () => this.close());
        this.openBtn.addEventListener("click", (e) => {
            e.preventDefault();
            this.open();
        });
    }

    /** Open the rewind scrubber panel. */
    open() {
        if (this.isOpen) return;

        this.snapshots = this.rewindBuffer.getAll();
        if (this.snapshots.length === 0) return;

        this.wasRunning = this.isRunning();
        if (this.wasRunning) this.stop(false);

        this.isOpen = true;
        this.savedState = this.processor.snapshotState();

        const thumbnails = renderThumbnails(this.processor, this.snapshots, this.video, this.captureInterval);
        this._populateFilmstrip(thumbnails);

        this.panel.hidden = false;
        // Use capture phase so keys don't leak to the emulator's keyboard handler
        document.addEventListener("keydown", this._onKeyDown, true);

        // Select the newest snapshot ("now") and jump to it
        this.selectedIndex = this.snapshots.length - 1;
        this._restoreAndPaint(this.selectedIndex);
        this._updateSelectionHighlight();
        this.filmstrip.scrollLeft = this.filmstrip.scrollWidth;
    }

    /**
     * Close the rewind panel, committing the selected snapshot.
     * Resumes the emulator if it was running before.
     */
    commit() {
        if (!this.isOpen) return;
        this._closePanel();
        if (this.wasRunning) this.go();
    }

    /**
     * Close the rewind panel, restoring the state from before it was opened.
     * Resumes the emulator if it was running before.
     */
    cancel() {
        if (!this.isOpen) return;
        this.processor.restoreState(this.savedState);
        executeUntilFrame(this.processor, this.video);
        this.video.paint();
        this._closePanel();
        if (this.wasRunning) this.go();
    }

    /** Alias for cancel — closing the panel without explicit commit cancels. */
    close() {
        this.cancel();
    }

    /**
     * Restore the emulator to the snapshot at the given index and update
     * both the main display and the filmstrip selection highlight.
     * @param {number} index - index into the snapshots array
     */
    selectSnapshot(index) {
        if (index < 0 || index >= this.snapshots.length) return;

        this.selectedIndex = index;
        this._restoreAndPaint(index);
        this._updateSelectionHighlight();
        this._scrollToSelected();
    }

    /** Update the disabled state of the Rewind menu item. */
    updateButtonState() {
        if (this.openBtn) {
            this.openBtn.classList.toggle("disabled", this.rewindBuffer.length === 0);
        }
    }

    _closePanel() {
        this.isOpen = false;
        this.panel.hidden = true;
        this.filmstrip.innerHTML = "";
        this.snapshots = [];
        this.savedState = null;
        document.removeEventListener("keydown", this._onKeyDown, true);
    }

    /** Restore a snapshot and run until vsync to produce a complete frame. */
    _restoreAndPaint(index) {
        this.processor.restoreState(this.snapshots[index]);
        executeUntilFrame(this.processor, this.video);
        this.video.paint();
    }

    _updateSelectionHighlight() {
        const thumbs = this.filmstrip.querySelectorAll(".rewind-thumb");
        for (const thumb of thumbs) {
            thumb.classList.toggle("selected", Number(thumb.dataset.index) === this.selectedIndex);
        }
    }

    _scrollToSelected() {
        const selected = this.filmstrip.querySelector(".rewind-thumb.selected");
        if (selected) {
            selected.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
        }
    }

    _populateFilmstrip(thumbnails) {
        this.filmstrip.innerHTML = "";
        for (const { canvas, index, ageSeconds } of thumbnails) {
            const wrapper = document.createElement("div");
            wrapper.className = "rewind-thumb";
            wrapper.dataset.index = index;
            wrapper.appendChild(canvas);

            const label = document.createElement("span");
            label.className = "rewind-thumb-label";
            label.textContent = ageSeconds === 0 ? "now" : `-${ageSeconds}s`;
            wrapper.appendChild(label);

            wrapper.addEventListener("click", () => this.selectSnapshot(index));
            this.filmstrip.appendChild(wrapper);
        }
    }

    _onKeyDown(e) {
        switch (e.key) {
            case "Escape":
                e.preventDefault();
                e.stopPropagation();
                this.cancel();
                break;
            case "Enter":
                e.preventDefault();
                e.stopPropagation();
                this.commit();
                break;
            case "ArrowLeft":
                e.preventDefault();
                e.stopPropagation();
                if (this.selectedIndex > 0) {
                    this.selectSnapshot(this.selectedIndex - 1);
                }
                break;
            case "ArrowRight":
                e.preventDefault();
                e.stopPropagation();
                if (this.selectedIndex < this.snapshots.length - 1) {
                    this.selectSnapshot(this.selectedIndex + 1);
                }
                break;
            default:
                // Swallow all other keys while the panel is open
                e.stopPropagation();
                break;
        }
    }
}
