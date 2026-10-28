import { hexword } from "../hex.js";
import { formatWatch, WatchFormats } from "../watches.js";
import { FloatingPanel, panelArrangement } from "./floating-panel.js";
import { StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 200, h: 80 };

/**
 * A floating list of addresses and their values, read once a frame while it is open and not at all
 * while it is closed. Watches are added by name or address, or from a menu offered at an address
 * (`offer`), and the add box gives the keyboard back to the machine on Escape or once a watch is added.
 */
export class WatchPanel {
    /**
     * @param {object} options
     * @param {(address: number) => number} options.peek - reads without side effects
     * @param {(text: string) => {address: number, label: string} | undefined} options.resolve
     */
    constructor({ peek, resolve }) {
        this._peek = peek;
        this._resolve = resolve;
        /** @type {{address: number, format: import("../watches.js").WatchFormat, value: HTMLElement}[]} */
        this._watches = [];
        this._frameHandle = null;
        /** @type {{opener: HTMLElement | null, popup: HTMLElement} | null} */
        this._openPopup = null;
        this.panel = document.getElementById("watch-panel");
        this._list = this.panel.querySelector(".watch-list");
        this._empty = this.panel.querySelector(".watch-empty");
        this._input = document.getElementById("watch-add");
        this._menu = document.getElementById("watch-menu");
        /** @type {{address: number, label: string} | null} */
        this._offered = null;
        for (const format of WatchFormats) {
            const choice = textButton("watch-menu-choice", `Watch ${format.name}`, format.description);
            choice.addEventListener("click", () => {
                this._showPopup(null);
                this._add(this._offered, format);
                this.floating.open();
            });
            this._menu.append(choice);
        }

        this.floating = new FloatingPanel({
            panel: this.panel,
            header: this.panel.querySelector(".watch-header"),
            closeButton: document.getElementById("watch-close"),
            id: "watches",
            title: "Watches",
            place: () => ({ x: StartEdge, y: StartEdge }),
            minSize: MinPanelSize,
            reopens: true,
            arrangement: panelArrangement,
        });
        this.floating.addEventListener("open", () => this._tick());
        this.floating.addEventListener("close", () => {
            cancelAnimationFrame(this._frameHandle);
            this._frameHandle = null;
            this._showPopup(null);
        });
        // Outside the panel, so its buttons are kept from focus here rather than by the panel.
        this._menu.addEventListener("mousedown", (e) => {
            if (e.target.closest("button")) e.preventDefault();
        });
        this._menu.addEventListener("contextmenu", (e) => e.preventDefault());
        // pointerdown, as the panel's drag handle cancels the mousedown that would follow.
        document.addEventListener(
            "pointerdown",
            (e) => {
                const open = this._openPopup;
                if (open && !open.opener?.contains(e.target) && !open.popup.contains(e.target)) this._showPopup(null);
            },
            true,
        );
        // Escape goes on to the page as well, as if nothing had been open.
        document.addEventListener(
            "keydown",
            (e) => {
                if (e.key === "Escape") this._showPopup(null);
            },
            true,
        );
        this._input.addEventListener("input", () => this._input.classList.remove("is-invalid"));
        document.getElementById("watch-add-form").addEventListener("submit", (e) => {
            e.preventDefault();
            const text = this._input.value.trim();
            if (!text) return;
            const found = this._resolve(text);
            this._input.classList.toggle("is-invalid", found === undefined);
            if (!found) return;
            this._add(found, WatchFormats[0]);
            this._input.value = "";
            this._input.blur();
        });
    }

    update() {
        for (const watch of this._watches) {
            const text = formatWatch(this._peek, watch.address, watch.format);
            if (watch.value.textContent !== text) watch.value.textContent = text;
        }
    }

    _tick() {
        this.update();
        this._frameHandle = requestAnimationFrame(() => this._tick());
    }

    /**
     * Offers a menu of formats to watch `what` in, at the window position `x`, `y`.
     * @param {{address: number, label: string}} what
     * @param {number} x
     * @param {number} y
     */
    offer(what, x, y) {
        this._offered = what;
        this._showPopup({ opener: null, popup: this._menu });
        this._menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - this._menu.offsetWidth))}px`;
        this._menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - this._menu.offsetHeight))}px`;
    }

    dismissMenu() {
        if (this._openPopup?.popup === this._menu) this._showPopup(null);
    }

    _add({ address, label }, initialFormat) {
        const row = document.createElement("tr");
        const cell = (className, text) => {
            const td = document.createElement("td");
            td.className = className;
            td.textContent = text;
            row.append(td);
            return td;
        };
        const name = cell("watch-name", label);
        name.title = `${label}: $${hexword(address)}`;
        const value = cell("watch-value", "");
        const watch = { address, format: initialFormat, value };

        const picker = textButton("watch-format dropdown-toggle", "", "");
        picker.setAttribute("aria-expanded", "false");
        const choices = document.createElement("tr");
        choices.className = "watch-formats";
        choices.hidden = true;
        const choiceCell = document.createElement("td");
        choiceCell.colSpan = 4;
        choices.append(choiceCell);
        const show = (format) => {
            watch.format = format;
            picker.textContent = format.name;
            picker.title = `Shown as ${format.description}`;
        };
        show(watch.format);
        picker.addEventListener("click", () =>
            this._showPopup(choices.hidden ? { opener: picker, popup: choices } : null),
        );
        for (const format of WatchFormats) {
            const choice = textButton("watch-format-choice", format.name, format.description);
            choice.addEventListener("click", () => {
                show(format);
                this._showPopup(null);
                this.update();
            });
            choiceCell.append(choice);
        }
        cell("", "").append(picker);

        const remove = textButton("watch-remove", "×", `Stop watching ${label}`);
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => {
            this._watches.splice(this._watches.indexOf(watch), 1);
            row.remove();
            choices.remove();
            this._empty.hidden = this._watches.length > 0;
        });
        cell("", "").append(remove);
        this._list.append(row, choices);
        this._watches.push(watch);
        this._empty.hidden = true;
        this.update();
    }

    /** Opens `open`'s popup, closing any other, or closes them all for null. */
    _showPopup(open) {
        const was = this._openPopup;
        if (was && was.popup !== open?.popup) {
            was.popup.hidden = true;
            was.opener?.setAttribute("aria-expanded", "false");
        }
        this._openPopup = open;
        if (!open) return;
        open.popup.hidden = false;
        open.opener?.setAttribute("aria-expanded", "true");
    }
}

function textButton(className, text, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `txt-btn ${className}`;
    button.textContent = text;
    button.title = title;
    // Out of the tab order, so Tab from the add box can't reach it either.
    button.tabIndex = -1;
    return button;
}
