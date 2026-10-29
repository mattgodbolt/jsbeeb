import { hexword } from "../hex.js";
import { formatWatch, parseCondition, WatchFormats, writeStops } from "../watches.js";
import { FloatingPanel } from "./floating-panel.js";
import { StartEdge } from "./panel-layout.js";
import { placePopup, popupBehaviour, textButton } from "./dom-utils.js";

const MinPanelSize = { w: 200, h: 80 };
const RowCells = 5;
// As the CPU's memStat marks a page: a write to ROM changes nothing, and one to neither reaches a device.
const RamStat = 1;
const RomStat = 2;
const AddressSpace = 0x10000;
const MaxAddress = AddressSpace - 1;
const DeviceNote = "A device register stops it on every write to it, never on a change the device makes itself.";

/**
 * A floating list of addresses and their values, read once a frame while it is open and the machine runs, and not
 * at all while it is closed. Watches are added by name or address, or from a menu offered at an address (`offer`),
 * and the add box gives the keyboard back to the machine on Escape or once a watch is added. A watch can stop the
 * machine on a write that changes it; the CPU takes its slower path only while one does.
 */
export class WatchPanel {
    /**
     * @param {object} options
     * @param {(address: number) => number} options.peek - reads without side effects
     * @param {(text: string) => {address: number, label: string} | undefined} options.resolve
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     */
    constructor({ peek, resolve, arrangement }) {
        this._peek = peek;
        this._resolve = resolve;
        /** @type {Watch[]} */
        this._watches = [];
        this._cpu = null;
        /** @type {{watches: Watch[], target: number} | null} */
        this._fired = null;
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
            id: "watches",
            title: "Watches",
            group: null,
            place: () => ({ x: StartEdge, y: StartEdge }),
            minSize: MinPanelSize,
            reopens: true,
            arrangement,
        });
        const refresh = arrangement.refreshing(
            () => this.floating.isOpen,
            () => this.update(),
        );
        this.floating.addEventListener("open", () => refresh.drawNow());
        this.floating.addEventListener("close", () => this._showPopup(null));
        popupBehaviour(
            this._menu,
            () => (this._openPopup ? [this._openPopup.opener, this._openPopup.popup] : null),
            () => this._showPopup(null),
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

    /** Sets the breakpoints of the watches that stop the machine on `cpu`, and no longer on the last one. */
    setCpu(cpu) {
        for (const watch of this._watches) this._unregister(watch);
        this._cpu = cpu;
        for (const watch of this._watches) this._register(watch);
        // A watch's breakpoint removed, disabled or made to log elsewhere, such as from the console, stops the watch
        // breaking.
        cpu.breakpoints.onChange(() => {
            const stops = new Map(cpu.breakpoints.list().map((bp) => [bp.id, bp.enabled && bp.action === "stop"]));
            for (const watch of this._watches) {
                if (watch.breakpoints.every((id) => stops.get(id))) continue;
                watch.breakpoints = watch.breakpoints.filter((id) => stops.has(id));
                watch.disarm();
            }
        });
    }

    /** Highlights the watches that stopped the machine, opening the panel to show them, or none if none did. */
    showWhichFired() {
        const cpu = this._cpu;
        // Only the stop the CPU is still in: a run outside the loop, such as a rewind preview, can fire one and go on.
        const fired = cpu?.halted && this._fired?.target === cpu.targetCycles ? this._fired.watches : [];
        for (const watch of this._watches) watch.row.classList.toggle("watch-fired", fired.includes(watch));
        if (fired.length > 0) this.floating.open();
        this._fired = null;
    }

    clearFired() {
        this._fired = null;
        this.showWhichFired();
    }

    /** Sets `watch`'s write breakpoints over its bytes, wrapping past &FFFF, if it stops the machine. */
    _register(watch) {
        this._unregister(watch);
        const cpu = this._cpu;
        if (!watch.breaks || !cpu) return;
        const last = watch.address + watch.format.bytes - 1;
        const ranges =
            last <= MaxAddress
                ? [[watch.address, last]]
                : [
                      [watch.address, MaxAddress],
                      [0, last - AddressSpace],
                  ];
        const accepts = (address, byte) => {
            const stat = cpu.memStat[cpu.memStatOffset + (address >>> 8)];
            const toRam = stat === RamStat;
            return stat !== RomStat && writeStops(this._peek, watch, address, byte, toRam, cpu, cpu.getPrevPc(0));
        };
        const onHit = () => {
            const target = cpu.targetCycles;
            if (this._fired?.target !== target) this._fired = { watches: [], target };
            if (!this._fired.watches.includes(watch)) this._fired.watches.push(watch);
        };
        // A name, not the address a watch with none is labelled by, and only where the watch starts.
        const named = watch.label !== `$${hexword(watch.address)}`;
        for (const [start, end] of ranges) {
            const label = named && start === watch.address ? watch.label : undefined;
            watch.breakpoints.push(
                cpu.breakpoints.add({ kind: "write", start, end, accepts, onHit, owner: "watch", label }),
            );
        }
    }

    _unregister(watch) {
        const ids = watch.breakpoints;
        // Emptied first, so that removing them is not taken for their being removed elsewhere.
        watch.breakpoints = [];
        for (const id of ids) this._cpu.breakpoints.remove(id);
    }

    update() {
        for (const watch of this._watches) {
            const text = formatWatch(this._peek, watch.address, watch.format);
            if (watch.value.textContent !== text) watch.value.textContent = text;
        }
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
        placePopup(this._menu, x, y);
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
        /** @type {Watch} */
        const watch = {
            address,
            label,
            format: initialFormat,
            value,
            row,
            breaks: false,
            condition: null,
            breakpoints: [],
            disarm: () => {},
        };

        const picker = textButton("watch-format dropdown-toggle", "", "");
        const [choices, choiceCell] = this._popupRow(picker, "watch-formats");
        const show = (format) => {
            watch.format = format;
            picker.textContent = format.name;
            picker.title = `Shown as ${format.description}`;
            this._register(watch);
        };
        show(watch.format);
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

        const breaker = textButton("watch-break dropdown-toggle", "", "");
        const [breaks, breakCell] = this._popupRow(breaker, "watch-breaks");
        const arm = (on, condition) => {
            watch.breaks = on;
            watch.condition = condition;
            breaker.textContent = `brk${condition?.text ?? ""}`;
            breaker.classList.toggle("armed", on);
            const when = condition ? `on a write that makes it ${condition.text}` : "on a write that changes it";
            breaker.title = `${on ? "Stops the machine" : "Stop the machine"} ${when}. ${DeviceNote}`;
            this._register(watch);
        };
        watch.disarm = () => arm(false, null);
        arm(false, null);
        const choose = (on, condition) => {
            arm(on, condition);
            this._showPopup(null);
        };
        const off = textButton("watch-break-choice", "off", "Never stop the machine for it");
        off.addEventListener("click", () => choose(false, null));
        const onChange = textButton("watch-break-choice", "on change", "Stop the machine on a write that changes it");
        onChange.addEventListener("click", () => choose(true, null));
        const conditionForm = document.createElement("form");
        const conditionBox = document.createElement("input");
        conditionBox.type = "text";
        conditionBox.className = "form-control form-control-sm panel-field watch-condition";
        conditionBox.placeholder = "e.g. 42, > $20";
        conditionBox.setAttribute("aria-label", `Stop the machine when ${label} becomes`);
        conditionBox.autocomplete = "off";
        conditionBox.addEventListener("input", () => conditionBox.classList.remove("is-invalid"));
        conditionForm.append(conditionBox);
        conditionForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const condition = parseCondition(conditionBox.value);
            conditionBox.classList.toggle("is-invalid", condition === undefined);
            if (!condition) return;
            choose(true, condition);
        });
        breakCell.append(off, onChange, conditionForm);
        cell("", "").append(breaker);

        const remove = textButton("watch-remove", "×", `Stop watching ${label}`);
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => {
            this._watches.splice(this._watches.indexOf(watch), 1);
            row.remove();
            choices.remove();
            breaks.remove();
            this._empty.hidden = this._watches.length > 0;
            this._unregister(watch);
        });
        cell("", "").append(remove);
        this._list.append(row, choices, breaks);
        this._watches.push(watch);
        this._empty.hidden = true;
        this.update();
    }

    /** A hidden row of choices under a watch, which `opener` shows and hides; returns it and its one cell. */
    _popupRow(opener, className) {
        opener.setAttribute("aria-expanded", "false");
        const popup = document.createElement("tr");
        popup.className = className;
        popup.hidden = true;
        const cell = document.createElement("td");
        cell.colSpan = RowCells;
        popup.append(cell);
        opener.addEventListener("click", () => this._showPopup(popup.hidden ? { opener, popup } : null));
        return [popup, cell];
    }

    /** Opens `open`'s popup, closing any other, or closes them all for null. */
    _showPopup(open) {
        const was = this._openPopup;
        if (was && was.popup !== open?.popup) {
            if (was.popup.contains(document.activeElement)) document.activeElement.blur();
            was.popup.hidden = true;
            was.opener?.setAttribute("aria-expanded", "false");
        }
        this._openPopup = open;
        if (!open) return;
        open.popup.hidden = false;
        open.opener?.setAttribute("aria-expanded", "true");
    }
}

/**
 * @typedef {object} Watch
 * @property {number} address
 * @property {import("../watches.js").WatchFormat} format
 * @property {HTMLElement} value
 * @property {HTMLElement} row
 * @property {string} label
 * @property {boolean} breaks - whether a write changing it stops the machine
 * @property {number[]} breakpoints - the ids of its write breakpoints, while it breaks
 * @property {() => void} disarm
 * @property {import("../watches.js").WatchCondition | null} condition - what the new value must be to stop it
 */
