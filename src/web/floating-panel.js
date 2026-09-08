/**
 * A panel that floats over the machine: hidden until opened, dragged by its
 * header, closed by its button or Escape, and kept inside the window as the
 * window changes size. Raises "open" and "close".
 */
export class FloatingPanel extends EventTarget {
    /**
     * @param {object} options
     * @param {HTMLElement} options.panel
     * @param {HTMLElement} options.header the drag handle
     * @param {HTMLElement} options.closeButton
     */
    constructor({ panel, header, closeButton }) {
        super();
        this.panel = panel;
        this.isOpen = false;
        this._position = null;
        this._drag = null;
        this._onResize = () => this._keepInWindow();
        closeButton.addEventListener("click", () => this.close());
        panel.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            this.close();
        });
        this._bindDrag(header);
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
        this._keepInWindow();
        this.dispatchEvent(new Event("open"));
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        // Focus left inside a hidden panel would keep the keyboard from the machine.
        if (this.panel.contains(document.activeElement)) document.activeElement.blur();
        this.panel.hidden = true;
        window.removeEventListener("resize", this._onResize);
        this.dispatchEvent(new Event("close"));
    }

    _bindDrag(header) {
        header.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || e.target.closest("button")) return;
            // The header is a drag handle only while it is styled as one, with the move cursor.
            if (getComputedStyle(header).cursor !== "move") return;
            const { left, top } = this.panel.getBoundingClientRect();
            this._drag = { pointerId: e.pointerId, grabX: e.clientX - left, grabY: e.clientY - top };
            header.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        header.addEventListener("pointermove", (e) => {
            if (!this._drag || this._drag.pointerId !== e.pointerId) return;
            this._moveTo(e.clientX - this._drag.grabX, e.clientY - this._drag.grabY);
        });
        for (const ending of ["pointerup", "pointercancel"])
            header.addEventListener(ending, (e) => {
                if (this._drag?.pointerId === e.pointerId) this._drag = null;
            });
    }

    _keepInWindow() {
        if (this._position) this._moveTo(this._position.left, this._position.top);
    }

    _moveTo(left, top) {
        const { width, height } = this.panel.getBoundingClientRect();
        this._position = {
            left: Math.min(Math.max(left, 0), Math.max(0, window.innerWidth - width)),
            top: Math.min(Math.max(top, 0), Math.max(0, window.innerHeight - height)),
        };
        this.panel.style.left = `${this._position.left}px`;
        this.panel.style.top = `${this._position.top}px`;
        // Dragging trades whatever anchored the panel at rest for an explicit position.
        this.panel.style.right = "auto";
        this.panel.style.bottom = "auto";
        this.panel.style.transform = "none";
    }
}
