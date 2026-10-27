import { hexword } from "../hex.js";
import { formatWatch, WatchFormats } from "../watches.js";
import { FloatingPanel } from "./floating-panel.js";

/**
 * A floating list of addresses and their values, read once a frame while it is open and not at all
 * while it is closed. Watches are added by name or address, and the add box gives the keyboard back
 * to the machine on Escape or once a watch is added.
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
        /** @type {{picker: HTMLElement, choices: HTMLElement} | null} */
        this._openChoices = null;
        this.panel = document.getElementById("watch-panel");
        this._list = this.panel.querySelector(".watch-list");
        this._empty = this.panel.querySelector(".watch-empty");
        this._input = document.getElementById("watch-add");

        document.getElementById("watch-open").addEventListener("click", (e) => {
            e.preventDefault();
            this.floating.toggle();
        });
        this.floating = new FloatingPanel({
            panel: this.panel,
            header: this.panel.querySelector(".watch-header"),
            closeButton: document.getElementById("watch-close"),
        });
        this.floating.addEventListener("open", () => this._tick());
        this.floating.addEventListener("close", () => {
            cancelAnimationFrame(this._frameHandle);
            this._frameHandle = null;
        });
        // A focused button would keep keys from the machine and the debugger.
        this.panel.addEventListener("mousedown", (e) => {
            if (e.target.closest("button")) e.preventDefault();
        });
        // pointerdown, as the panel's drag handle cancels the mousedown that would follow.
        document.addEventListener(
            "pointerdown",
            (e) => {
                const open = this._openChoices;
                if (open && !open.picker.contains(e.target) && !open.choices.contains(e.target))
                    this._showChoices(null);
            },
            true,
        );
        this._input.addEventListener("input", () => this._input.classList.remove("is-invalid"));
        this._input.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            // Neither the panel nor the page sees it: one would close, the other pass Escape on to the machine.
            e.stopPropagation();
            this._input.blur();
        });
        document.getElementById("watch-add-form").addEventListener("submit", (e) => {
            e.preventDefault();
            const text = this._input.value.trim();
            if (!text) return;
            const found = this._resolve(text);
            this._input.classList.toggle("is-invalid", found === undefined);
            if (!found) return;
            this._add(found);
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

    _add({ address, label }) {
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
        const watch = { address, format: WatchFormats[0], value };

        const picker = textButton("watch-format dropdown-toggle", "", `How to show ${label}`);
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
        picker.addEventListener("click", () => this._showChoices(choices.hidden ? { picker, choices } : null));
        for (const format of WatchFormats) {
            const choice = textButton("watch-format-choice", format.name, format.description);
            choice.addEventListener("click", () => {
                show(format);
                this._showChoices(null);
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

    /** Opens a watch's list of formats, closing any other, or closes them all for null. */
    _showChoices(open) {
        if (this._openChoices && this._openChoices.choices !== open?.choices) {
            this._openChoices.choices.hidden = true;
            this._openChoices.picker.setAttribute("aria-expanded", "false");
        }
        this._openChoices = open;
        if (!open) return;
        open.choices.hidden = false;
        open.picker.setAttribute("aria-expanded", "true");
    }
}

function textButton(className, text, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `txt-btn ${className}`;
    button.textContent = text;
    button.title = title;
    // Tab would otherwise be a way into the panel, and a focused button keeps keys from the debugger.
    button.tabIndex = -1;
    return button;
}
