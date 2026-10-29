import { hexword } from "../hex.js";
import { DebugGroup, FloatingPanel, panelShell } from "./floating-panel.js";
import { EndEdge } from "./panel-layout.js";

const MinPanelSize = { w: 360, h: 100 };
const StorageKey = "debugBreakpoints";
const StoreVersion = 1;
const SavedFields = ["kind", "start", "end", "bank", "condition", "hitCount", "enabled", "action", "label"];
const SidewaysStart = 0x8000;
const SidewaysEnd = 0xbfff;
const Kinds = [
    { kind: "execute", short: "X", name: "Execute", title: "Acts before the CPU runs an instruction here" },
    { kind: "read", short: "R", name: "Read", title: "Acts after an instruction reads here, fetches included" },
    { kind: "write", short: "W", name: "Write", title: "Acts after an instruction writes here" },
    { kind: "access", short: "RW", name: "Read or write", title: "Acts after an instruction reads or writes here" },
];
const KindOf = new Map(Kinds.map((kind) => [kind.kind, kind]));
const RangeSeparator = /\s*-\s*/;

function textButton(className, text, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `txt-btn ${className}`;
    button.textContent = text;
    button.title = title;
    button.tabIndex = -1;
    return button;
}

function rangeText({ start, end }) {
    return start === end ? `$${hexword(start)}` : `$${hexword(start)}-$${hexword(end)}`;
}

/**
 * The Breakpoints panel: every breakpoint the CPU has, however it was set, each enabled or not, stopping or logging,
 * with its condition and hit count, and a form to add one. It saves the user's breakpoints in browser storage, and
 * puts them back on the next visit.
 */
export class BreakpointsPanel {
    /**
     * @param {object} options
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {(text: string) => {address: number, name: string | undefined} | undefined} options.resolve - the address
     * a name or number gives, and the name if it was one
     * @param {(address: number) => string | undefined} options.nameOf - the name the debugger shows for an address
     * @param {(address: number) => void} options.showCode
     * @param {(address: number) => void} options.showMemory
     * @param {(() => Storage) | null} options.storage - where breakpoints are kept between visits, or null
     */
    constructor({ arrangement, resolve, nameOf, showCode, showMemory, storage }) {
        this._resolve = resolve;
        this._nameOf = nameOf;
        this._showCode = showCode;
        this._showMemory = showMemory;
        this._storage = storage;
        this._cpu = null;
        /** @type {import("../breakpoints.js").Breakpoints | null} */
        this._breakpoints = null;
        this._unrestored = [];
        this._stoppedBy = null;
        this._hitCells = new Map();
        this._nameCells = new Map();
        /** @type {{id: number, field: string, input: HTMLInputElement} | null} */
        this._editing = null;
        this._rendering = false;
        this._newKind = Kinds[0];

        const { panel, body } = panelShell({ id: "breakpoints", title: "Breakpoints", feature: "breakpoints" });
        this.panel = panel;
        body.innerHTML = `
            <table class="bp-list"><tbody></tbody></table>
            <div class="bp-empty">None set. Click beside an instruction in the disassembly, or add one here.</div>
            <form class="bp-add-form" role="form">
              <input type="text" class="form-control form-control-sm panel-field bp-add"
                aria-label="Address, range or name to break on" placeholder="Address, range or name, then Enter" />
            </form>`;
        this._list = body.querySelector("tbody");
        this._empty = body.querySelector(".bp-empty");
        const form = body.querySelector(".bp-add-form");
        this._input = form.querySelector(".bp-add");
        this._kindButton = textButton("bp-add-kind", "", "");
        form.prepend(this._kindButton);
        this._showNewKind(this._newKind);
        this._kindButton.addEventListener("click", () =>
            this._showNewKind(Kinds[(Kinds.indexOf(this._newKind) + 1) % Kinds.length]),
        );
        this._input.addEventListener("input", () => this._invalid(this._input, null));
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            this._addTyped();
        });

        this.floating = new FloatingPanel({
            panel,
            id: "breakpoints",
            title: "Breakpoints",
            group: DebugGroup,
            place: () => ({ x: EndEdge, y: EndEdge }),
            minSize: MinPanelSize,
            reopens: true,
            arrangement,
        });
        const refresh = arrangement.refreshing(
            () => this.floating.isOpen,
            () => this.update(),
        );
        this.floating.addEventListener("open", () => refresh.drawNow());
    }

    /** Shows `cpu`'s breakpoints, first putting back the ones saved on an earlier visit. */
    setCpu(cpu) {
        this._cpu = cpu;
        this._breakpoints = cpu.breakpoints;
        this._restore();
        this._breakpoints.onChange(() => {
            this._save();
            this._render();
        });
        this._breakpoints.onHit((hit) => {
            if (hit.action !== "stop" || this._stoppedBy === hit.id) return;
            this._stoppedBy = hit.id;
            this._render();
        });
        this._render();
    }

    /** Shows each breakpoint's hits as they are now, and its address's name, which can come with symbols later. */
    update() {
        if (!this._breakpoints) return;
        for (const { id, start, hits, hitCount, label } of this._breakpoints.list()) {
            const hitText = hitCount > 1 ? `${hits} of ${hitCount}` : `${hits}`;
            const hitCell = this._hitCells.get(id);
            if (hitCell && hitCell.textContent !== hitText) hitCell.textContent = hitText;
            const nameText = label ?? this._nameOf(start) ?? "";
            const nameCell = this._nameCells.get(id);
            if (nameCell && nameCell.textContent !== nameText) nameCell.textContent = nameText;
        }
    }

    _showNewKind(kind) {
        this._newKind = kind;
        this._kindButton.textContent = kind.name;
        this._kindButton.title = `${kind.title}; click for another kind`;
    }

    _addTyped() {
        const text = this._input.value.trim();
        if (!text) return;
        const [from, to] = text.split(RangeSeparator, 2);
        const start = this._resolve(from);
        const end = to === undefined ? start : this._resolve(to);
        if (!start || !end) {
            this._invalid(this._input, `No address called "${!start ? from : to}"`);
            return;
        }
        try {
            this._breakpoints.add({
                kind: this._newKind.kind,
                start: start.address,
                end: end.address,
                label: to === undefined ? start.name : undefined,
            });
        } catch (error) {
            this._invalid(this._input, error.message);
            return;
        }
        this._input.value = "";
        this._input.blur();
    }

    _invalid(input, message) {
        input.classList.toggle("is-invalid", message !== null);
        input.title = message ?? "";
    }

    /** Lists the breakpoints again, keeping a field being edited, with the keyboard, in its breakpoint's new row. */
    _render() {
        this._rendering = true;
        try {
            this._list.replaceChildren();
            this._hitCells.clear();
            this._nameCells.clear();
            const all = this._breakpoints.list();
            for (const breakpoint of all) this._list.append(this._row(breakpoint));
            this._empty.hidden = all.length > 0;
            this.update();
        } finally {
            this._rendering = false;
        }
        const editing = this._editing;
        if (editing && this._list.contains(editing.input)) editing.input.focus();
        else this._editing = null;
    }

    /** `button`, or the field editing `field` of breakpoint `id` in its place. */
    _orEditing(button, id, field) {
        const editing = this._editing;
        return editing?.id === id && editing.field === field ? editing.input : button;
    }

    _row(breakpoint) {
        const { id, kind, start, end, bank, condition, enabled, action, owner } = breakpoint;
        const change = (changes) => this._breakpoints.update(id, changes);
        const row = document.createElement("tr");
        row.dataset.id = String(id);
        row.classList.toggle("bp-stopped", this._stoppedBy === id);
        if (this._stoppedBy === id) row.title = "This breakpoint stopped the machine last";
        const cell = (className, ...content) => {
            const td = document.createElement("td");
            td.className = className;
            td.append(...content);
            row.append(td);
            return td;
        };

        const enable = textButton(
            `bp-enabled bp_gutter ${enabled ? "active" : "disabled"}`,
            "",
            enabled ? "Enabled; click to disable" : "Disabled; click to enable",
        );
        enable.addEventListener("click", () => change({ enabled: !enabled }));
        cell("", enable);

        const { short, title } = KindOf.get(kind);
        cell("bp-kind", short).title = title;

        const where = textButton("bp-where", rangeText(breakpoint), `Show ${rangeText(breakpoint)}`);
        where.addEventListener("click", () => (kind === "execute" ? this._showCode(start) : this._showMemory(start)));
        const whereCell = cell("bp-address", where);
        const name = document.createElement("span");
        name.className = "bp-name";
        this._nameCells.set(id, name);
        whereCell.append(name);
        if (owner !== "user") whereCell.append(` (from ${owner})`);
        const sideways = !this._cpu.model.isAtom && start >= SidewaysStart && end <= SidewaysEnd;
        if (sideways || bank !== undefined) whereCell.append(this._bankButton(bank, change));

        const conditionButton = textButton(condition ? "" : "bp-placeholder", condition ?? "always", "");
        this._editOnClick(conditionButton, { id, field: "condition" }, condition ?? "", "Condition", (text) =>
            change({ condition: text }),
        );
        cell("bp-condition", this._orEditing(conditionButton, id, "condition"));

        const hits = textButton("bp-hits", "", "");
        this._editOnClick(
            hits,
            { id, field: "hitCount" },
            String(breakpoint.hitCount),
            "Hits so far; the hit to stop from",
            (text) => change({ hitCount: Number(text) }),
        );
        this._hitCells.set(id, hits);
        cell("bp-hit-count", this._orEditing(hits, id, "hitCount"));

        const actionButton = textButton(
            "bp-action",
            action,
            action === "stop"
                ? "Stops the machine; click to log hits to the console instead"
                : "Logs each hit to the console; click to stop instead",
        );
        actionButton.addEventListener("click", () => change({ action: action === "stop" ? "log" : "stop" }));
        cell("", actionButton);

        const remove = textButton("bp-remove", "×", `Remove the breakpoint at ${rangeText(breakpoint)}`);
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => this._breakpoints.remove(id));
        cell("", remove);
        return row;
    }

    _bankButton(bank, change) {
        const button = textButton(
            "bp-bank",
            bank === undefined ? "any ROM" : `ROM ${bank}`,
            bank === undefined
                ? "Stops whichever ROM is paged in; click to stop only in the one paged in then"
                : `Stops only while ROM ${bank} is paged in; click for any ROM`,
        );
        button.addEventListener("click", () => change({ bank: bank === undefined ? this._cpu.pagedBank : undefined }));
        return button;
    }

    /**
     * Makes `button` turn into a field editing `what` (`field` of breakpoint `id`), holding `text`, when clicked. It
     * commits on Enter, and puts the button back, as it was, on Escape or on leaving it. A change the field cannot
     * take marks it, with the reason as its tooltip.
     */
    _editOnClick(button, { id, field }, text, what, commit) {
        button.title = `${what}; click to change`;
        button.addEventListener("click", () => {
            const input = document.createElement("input");
            input.type = "text";
            input.className = "form-control form-control-sm panel-field bp-edit";
            input.value = text;
            input.setAttribute("aria-label", what);
            input.addEventListener("input", () => this._invalid(input, null));
            input.addEventListener("keydown", (e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                try {
                    commit(input.value);
                } catch (error) {
                    this._invalid(input, error.message);
                    return;
                }
                input.blur();
            });
            // Moving the field into a redrawn row blurs it too; that is not leaving it.
            input.addEventListener("blur", () => {
                if (this._rendering) return;
                if (this._editing?.input === input) this._editing = null;
                this._render();
            });
            this._editing = { id, field, input };
            button.replaceWith(input);
            input.focus();
        });
    }

    _restore() {
        if (!this._storage) return;
        let saved;
        try {
            saved = JSON.parse(this._storage().getItem(StorageKey) ?? "null");
        } catch (error) {
            console.warn(`Could not read the saved breakpoints: ${error}`);
            return;
        }
        if (saved?.version !== StoreVersion || !Array.isArray(saved.breakpoints)) return;
        for (const spec of saved.breakpoints) {
            try {
                this._breakpoints.add(Object.fromEntries(SavedFields.map((field) => [field, spec?.[field]])));
            } catch (error) {
                // Kept for a machine with a socket for its bank; anything else wrong with it is dropped.
                if (spec?.bank !== undefined) this._unrestored.push(spec);
                console.warn(`Could not put back a saved breakpoint: ${error.message}`);
            }
        }
    }

    _save() {
        if (!this._storage) return;
        const breakpoints = this._breakpoints
            .list()
            .filter(({ owner }) => owner === "user")
            .map((breakpoint) => Object.fromEntries(SavedFields.map((field) => [field, breakpoint[field]])));
        try {
            this._storage().setItem(
                StorageKey,
                JSON.stringify({ version: StoreVersion, breakpoints: [...breakpoints, ...this._unrestored] }),
            );
        } catch (error) {
            console.warn(`Could not save the breakpoints: ${error}`);
        }
    }
}
