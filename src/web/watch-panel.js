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
        const format = document.createElement("select");
        format.className = "form-select form-select-sm watch-format";
        format.setAttribute("aria-label", `How to show ${label}`);
        for (const { name, description } of WatchFormats) {
            const option = new Option(name, name);
            option.title = description;
            format.add(option);
        }
        format.title = watch.format.description;
        format.addEventListener("change", () => {
            watch.format = WatchFormats.find(({ name }) => name === format.value);
            format.title = watch.format.description;
            format.blur();
            this.update();
        });
        // Focus left on a menu closed without a pick would keep the player's keys, and its type-ahead change the format.
        format.addEventListener("keydown", (e) => {
            if (e.key === "Escape") return;
            e.preventDefault();
            format.blur();
        });
        const formatCell = document.createElement("td");
        formatCell.append(format);
        const remove = this._button("watch-remove", "×", () => {
            this._watches.splice(this._watches.indexOf(watch), 1);
            row.remove();
            this._empty.hidden = this._watches.length > 0;
        });
        remove.title = `Stop watching ${label}`;
        remove.setAttribute("aria-label", remove.title);
        row.append(formatCell, remove.parentElement);
        this._list.append(row);
        this._watches.push(watch);
        this._empty.hidden = true;
        this.update();
    }

    _button(className, text, onClick) {
        const td = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button";
        button.className = `txt-btn ${className}`;
        button.textContent = text;
        button.addEventListener("click", onClick);
        td.append(button);
        return button;
    }
}
