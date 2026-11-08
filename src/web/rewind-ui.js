import { renderThumbnails, previewFrame } from "./rewind-thumbnail.js";
import { RewindBuffer } from "../rewind.js";
import { copySnapshot } from "../6502.js";
import { PageHistory } from "../replay.js";
import { RewindCaptureInterval } from "./emulation-loop.js";
import { noteFeature } from "./analytics.js";
import { Shortcuts } from "./shortcuts.js";
import { keyCodes } from "../keymap.js";

// The rest would act on a machine that is only showing a preview.
const ShortcutsWhileOpen = new Set(["toggleRewind", "toggleFast", "openPrinter"]);
const ShortcutCodesWhileOpen = new Set(
    Shortcuts.filter(({ run }) => ShortcutsWhileOpen.has(run)).map(({ key }) => keyCodes[key]),
);

/**
 * Rewind scrubber UI — a filmstrip overlay showing thumbnails of recent
 * emulator states, allowing the user to click to restore any of them.
 */
export class RewindUI {
    /**
     * @param {object} options
     * @param {object} options.loop - the emulation loop: says when to capture, and is held while the panel is open
     * @param {import("../replay.js").ReplayHistory} options.history - what the debugger steps back through, told of
     * every snapshot kept and when they are all forgotten, and telling of a step back that leaves the newer ones
     * a future the machine no longer has; the panel previews and goes back through it too
     */
    constructor({ loop, history }) {
        this.rewindBuffer = new RewindBuffer(PageHistory.seconds);
        // The last few frames, newest last; the rewind history is copied from them.
        this.frames = new RewindBuffer(PageHistory.recent);
        this.history = history;
        this.processor = history.cpu;
        this.video = history.cpu.video;
        this.loop = loop;
        loop.addEventListener("frame-capture", () => this.captureFrame());
        loop.addEventListener("rewind-capture", () => this.capture());
        loop.addEventListener("replacing-state", () => {
            this.frames.clear();
            this.history.restart();
        });
        history.addEventListener("landed", ({ detail }) => this.forget(detail.forgotten));

        this.panel = document.getElementById("rewind-panel");
        this.filmstrip = document.getElementById("rewind-filmstrip");
        this.closeBtn = document.getElementById("rewind-close");
        this.openBtn = document.getElementById("rewind-open");

        this.isOpen = false;
        this.resumeLoop = null;
        this.selectedIndex = -1;
        this.snapshots = [];
        this.original = null;

        this._onKeyDown = this._onKeyDown.bind(this);
        this.closeBtn.addEventListener("click", () => this.close());
        this.openBtn.addEventListener("click", (e) => {
            e.preventDefault();
            this.open();
        });
    }

    captureFrame() {
        const replacing = this.frames.nextToReplace();
        const snapshot = this.processor.snapshotState({ into: replacing });
        this.frames.push(snapshot);
        this.history.taken(snapshot, replacing);
    }

    capture() {
        const replacing = this.rewindBuffer.nextToReplace();
        const snapshot = copySnapshot(this.frames.peek(), replacing);
        this.rewindBuffer.push(snapshot);
        this.history.taken(snapshot, replacing);
        this.history.trim();
        this.updateButtonState();
    }

    /** Forgets `forgotten`, the newest snapshots, as the machine has stepped back before them. */
    forget(forgotten) {
        for (const ring of [this.frames, this.rewindBuffer]) {
            while (ring.length > 0 && forgotten.has(ring.peek())) ring.pop();
        }
        this.updateButtonState();
    }

    /** Forget everything captured, as on a hard reset or as a guest takes the host's machine. */
    reset() {
        this.close();
        this.rewindBuffer.clear();
        this.frames.clear();
        this.history.restart();
        this.updateButtonState();
    }

    /** Open the rewind scrubber panel. */
    open() {
        if (this.isOpen) return;

        this.snapshots = this.rewindBuffer.getAll();
        if (this.snapshots.length === 0) return;

        this.resumeLoop = this.loop.hold("the rewind panel");
        this.isOpen = true;
        try {
            this.original = this.history.original();
            this._populateFilmstrip(renderThumbnails(this.history, this.snapshots, RewindCaptureInterval));
            this.panel.hidden = false;
            // Use capture phase so keys don't leak to the emulator's keyboard handler
            document.addEventListener("keydown", this._onKeyDown, true);

            this.selectedIndex = this.snapshots.length - 1;
            this._preview(this.selectedIndex);
            this._updateSelectionHighlight();
            this.filmstrip.scrollLeft = this.filmstrip.scrollWidth;
            noteFeature(this.panel, "open");
        } catch (e) {
            if (this.original) this.history.putBack(this.original);
            this._closePanel();
            throw e;
        }
    }

    /**
     * Closes the panel with the machine gone back to the chosen snapshot, as a step back lands: the seconds after it
     * are forgotten, and the machine runs on from it holding what the host holds now.
     */
    commit() {
        if (!this.isOpen) return;
        const snapshot = this.snapshots[this.selectedIndex];
        this.history.landAt(snapshot, this.original.host);
        // The history forgets only what it keeps, which leaves out seconds from before a state was loaded.
        while (this.rewindBuffer.peek() !== snapshot) this.rewindBuffer.pop();
        noteFeature(this.panel, "rewound");
        this._closePanel();
    }

    /** Goes back as `commit` does and stops in the debugger there. */
    commitAndStop() {
        if (!this.isOpen) return;
        this.commit();
        this.loop.stop(true);
    }

    /** Closes the panel with the machine, its picture and its history as they were before it opened. */
    cancel() {
        if (!this.isOpen) return;
        this.history.putBack(this.original);
        this.video.paint();
        this._closePanel();
    }

    /** Alias for cancel — closing the panel without explicit commit cancels. */
    close() {
        this.cancel();
    }

    toggle() {
        if (this.isOpen) this.cancel();
        else this.open();
    }

    /**
     * Restore the emulator to the snapshot at the given index and update
     * both the main display and the filmstrip selection highlight.
     * @param {number} index - index into the snapshots array
     */
    selectSnapshot(index) {
        if (index < 0 || index >= this.snapshots.length) return;

        this.selectedIndex = index;
        this._preview(index);
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
        this.original = null;
        document.removeEventListener("keydown", this._onKeyDown, true);
        this.resumeLoop?.();
        this.resumeLoop = null;
    }

    // Leaves the machine where the preview ran to; going back or cancelling puts it where it belongs.
    _preview(index) {
        previewFrame(this.history, this.snapshots[index]);
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
        if (e.altKey && !e.ctrlKey && ShortcutCodesWhileOpen.has(e.code)) return;
        // By key code, so that the Mac's Option characters count.
        if (e.altKey && e.code === "KeyS") {
            e.preventDefault();
            e.stopPropagation();
            this.commitAndStop();
            return;
        }
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
                // Block keys from reaching the emulator but allow browser
                // shortcuts (Tab, accessibility keys, etc.) to work normally
                e.stopPropagation();
                break;
        }
    }
}
