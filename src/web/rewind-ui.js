import { renderThumbnails, previewFrame } from "./rewind-thumbnail.js";
import { RewindBuffer } from "../rewind.js";
import { copySnapshot } from "../6502.js";
import { PageHistory } from "../replay.js";
import { RewindCaptureInterval, RunMode } from "./emulation-loop.js";
import { noteFeature } from "./analytics.js";
import { FloatingPanel } from "./floating-panel.js";
import { EndEdge } from "./panel-layout.js";
import { keyLine } from "./panel-keys.js";
import { Shortcuts, shortcutLabel } from "./shortcuts.js";
import { keyCodes } from "../keymap.js";

// Tall enough for a row of thumbnails and, at this width or more, the line of keys under them, so that the default
// place, kept clear of the lights, is never one that cuts them off.
const MinPanelSize = { w: 480, h: 230 };
const StretchedAcross = { anchor: "stretch" };

// The rest would act on a machine the loop holds while the screen shows a preview.
const ShortcutsWhileOpen = new Set(["toggleRewind", "toggleFast", "openPrinter"]);
const ShortcutCodesWhileOpen = new Set(
    Shortcuts.filter(({ run }) => ShortcutsWhileOpen.has(run)).map(({ key }) => keyCodes[key]),
);

/**
 * The keys the rewind window answers while it is open, in the shape of the Shortcuts table (see panel-keys.js),
 * whichever window has the focus, as the machine is held and gets no keys meanwhile. A key with Alt is named by
 * its key code, as "Alt-S", so that the Mac's Option characters count.
 */
export const RewindKeys = [
    { combo: "Left Right", label: "choose", description: "Choose an earlier or later moment" },
    { key: "ArrowLeft", run: "earlier" },
    { key: "ArrowRight", run: "later" },
    {
        combo: "Enter",
        key: "Enter",
        run: "commit",
        label: "go back",
        description: "Go back to the chosen moment, forgetting the seconds after it",
    },
    {
        combo: "Alt-S",
        key: "Alt-S",
        run: "commitAndStop",
        label: "go back and debug",
        description: "Go back to the chosen moment and stop in the debugger there",
    },
    {
        combo: "Escape",
        key: "Escape",
        run: "cancel",
        label: "cancel",
        description: "Close, leaving the machine where it was",
    },
];

// AltGr is Ctrl with Alt, and types a character rather than naming a shortcut; Alt with any other key is that key.
const keyName = (e) => (e.altKey && !e.ctrlKey && e.code.startsWith("Key") ? `Alt-${e.code.slice(3)}` : e.key);

/**
 * The rewind window: a filmstrip of the machine's last seconds, from which it can go back to any of them. The
 * machine is held while it is open.
 */
export class RewindUI {
    /**
     * @param {object} options
     * @param {object} options.loop - the emulation loop: says when to capture, and is held while the panel is open
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement - what places the window
     * @param {import("../replay.js").ReplayHistory} options.history - what the debugger steps back through, told of
     * every snapshot kept and when they are all forgotten, and telling of a step back that leaves the newer ones
     * a future the machine no longer has; the panel previews and goes back through it too
     */
    constructor({ loop, history, arrangement }) {
        this.rewindBuffer = new RewindBuffer(PageHistory.seconds);
        // The last few frames, newest last; the rewind history is copied from them.
        this.frames = new RewindBuffer(PageHistory.recent);
        this.history = history;
        this.processor = history.cpu;
        this.video = history.cpu.video;
        this.loop = loop;
        loop.addEventListener("frame-capture", () => this.captureFrame());
        loop.addEventListener("rewind-capture", () => this.capture());
        // What came before is another machine's past, which neither rewind nor step back can go back into.
        loop.addEventListener("replacing-state", () => {
            if (this.isOpen) this._closePanel();
            this.forgetAll();
        });
        history.addEventListener("landed", ({ detail }) => {
            // A step back from the debugger moves the machine from under an open panel, and may forget its seconds.
            if (this.isOpen) this._closePanel();
            this.forget(detail.forgotten);
        });

        this.panel = document.getElementById("rewind-panel");
        this.filmstrip = document.getElementById("rewind-filmstrip");
        this.openBtn = document.getElementById("rewind-open");
        this.panel.querySelector(".panel-keys").textContent = shortcutLabel(keyLine(RewindKeys));
        this.floating = new FloatingPanel({
            panel: this.panel,
            id: "rewind",
            title: null,
            menuGroup: null,
            group: null,
            place: () => ({ x: StretchedAcross, y: EndEdge }),
            minSize: MinPanelSize,
            arrangement,
        });
        // Its close button; Escape goes to the key handler, wherever the focus is.
        this.floating.addEventListener("close", () => this.cancel());
        this._actions = {
            earlier: () => this.selectSnapshot(this.selectedIndex - 1),
            later: () => this.selectSnapshot(this.selectedIndex + 1),
            commit: () => this.commit(false),
            commitAndStop: () => this.commit(true),
            cancel: () => this.cancel(),
        };

        this.isOpen = false;
        this.resumeLoop = null;
        this.selectedIndex = -1;
        this.snapshots = [];
        this.picture = null;

        this._onKeyDown = this._onKeyDown.bind(this);
        // Whatever a keypress would do, as the debugger's keys answer it, would act on a machine that is held.
        this._onKeyPress = (e) => e.stopPropagation();
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
        this.cancel();
        this.forgetAll();
    }

    forgetAll() {
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
        this.video.renderPending();
        this.picture = this.video.fb32.slice();
        try {
            this._populateFilmstrip(
                this._aside(() => renderThumbnails(this.history, this.snapshots, RewindCaptureInterval)),
            );
            this.floating.open();
            // In the capture phase, so that the machine's keyboard handler never sees them.
            document.addEventListener("keydown", this._onKeyDown, true);
            document.addEventListener("keypress", this._onKeyPress, true);

            this.selectedIndex = this.snapshots.length - 1;
            this._preview(this.selectedIndex);
            this._updateSelectionHighlight();
            this.filmstrip.scrollLeft = this.filmstrip.scrollWidth;
        } catch (e) {
            this._closePanel();
            throw e;
        }
    }

    /**
     * Closes the panel with the machine gone back to the chosen snapshot, as a step back lands: the seconds after it
     * are forgotten, and the machine runs on from it holding what the host holds now. In the debugger, or with
     * `stopping`, it stops in the debugger there.
     */
    commit(stopping) {
        if (!this.isOpen) return;
        // Closed first, so that its own landing is not taken for one from elsewhere.
        this.isOpen = false;
        this.history.landAt(this.snapshots[this.selectedIndex]);
        noteFeature(this.panel, "rewound");
        const debugging = this.loop.mode === RunMode.debugging;
        this._closePanel();
        if (stopping || debugging) this.loop.stop(true);
    }

    /** Closes the panel with the machine, its picture and its history where they are. */
    cancel() {
        if (!this.isOpen) return;
        this.video.fb32.set(this.picture);
        this.video.paint();
        this._closePanel();
    }

    toggle() {
        if (this.isOpen) this.cancel();
        else this.open();
    }

    /**
     * Chooses the snapshot at `index`, showing it on the screen and in the filmstrip; the machine stays where it is.
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
        this.floating.close();
        this.filmstrip.innerHTML = "";
        this.snapshots = [];
        this.picture = null;
        document.removeEventListener("keydown", this._onKeyDown, true);
        document.removeEventListener("keypress", this._onKeyPress, true);
        this.resumeLoop?.();
        this.resumeLoop = null;
    }

    // The preview stays in the picture, so that a repaint while the panel is open, or going back, shows it.
    _preview(index) {
        const shown = this._aside(() => {
            previewFrame(this.history, this.snapshots[index]);
            this.video.renderPending();
            return this.video.fb32.slice();
        });
        this.video.fb32.set(shown);
        this.video.paint();
    }

    /**
     * Runs `run` on the machine's past, then puts the machine, the host's inputs and the picture back as they are now,
     * so that whatever the host does while the panel is open (a key let go, the page losing the focus, an edit in the
     * debugger) goes in where the machine is.
     */
    _aside(run) {
        const now = this.history.original();
        try {
            return run();
        } finally {
            this.history.putBack(now);
        }
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
        e.stopPropagation();
        const row = RewindKeys.find(({ key }) => key === keyName(e));
        if (!row) return;
        e.preventDefault();
        this._actions[row.run]();
    }
}
