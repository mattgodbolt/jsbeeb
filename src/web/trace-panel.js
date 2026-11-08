import { hexbyte, hexword } from "../hex.js";
import { recentInstructions, TraceDepth } from "../instruction-trace.js";
import { cycleCount } from "../lockstep.js";
import { setText } from "./dom-utils.js";
import { DebugGroup, MenuGroup, panelShell } from "./floating-panel.js";
import { EndEdge, StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 360, h: 100 };
const Flags = [
    [0x80, "N"],
    [0x40, "V"],
    [0x08, "D"],
    [0x04, "I"],
    [0x02, "Z"],
    [0x01, "C"],
];
const RegisterTitle = "As the instruction began, or once the interrupt was taken";
const Columns = [
    ["Cycles", "How many cycles before now it came"],
    ["At", "Where it ran, or for an interrupt where its handler returns to"],
    ["", ""],
    ["Instruction", ""],
    ...["A", "X", "Y", "S", "Flags"].map((register) => [register, RegisterTitle]),
];
const Running = "Stop the machine in the debugger to see the instructions it ran before it stopped.";

const flagsText = (p) => Flags.map(([bit, name]) => (p & bit ? name : name.toLowerCase())).join("");

/**
 * The Trace panel: the instructions the machine ran before where it is stopped, the newest last, each with the
 * registers as it began and how long before now, and the interrupts taken between them. It finds them by replaying
 * the history step back keeps (see instruction-trace.js), so only while the machine is stopped in the debugger.
 */
export class TracePanel {
    /**
     * @param {object} options
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {() => import("../replay.js").ReplayHistory | null} options.history
     * @param {() => string | null} options.unavailable - why the page cannot replay its history, or null
     * @param {() => boolean} options.stopped - whether the machine is stopped in the debugger
     * @param {(address: number) => string | undefined} options.nameOf - the name the debugger gives an address
     * @param {(address: number) => void} options.showCode
     */
    constructor({ arrangement, history, unavailable, stopped, nameOf, showCode }) {
        this._history = history;
        this._unavailable = unavailable;
        this._stopped = stopped;
        this._nameOf = nameOf;
        this._cpu = null;
        this._reader = null;
        this._tracing = null;
        const { floating, body } = panelShell({
            id: "trace",
            title: "Trace",
            feature: "trace",
            menuGroup: MenuGroup.cpu,
            group: DebugGroup,
            place: () => ({ x: StartEdge, y: EndEdge }),
            minSize: MinPanelSize,
            arrangement,
        });
        this.floating = floating;
        body.innerHTML = `
            <div class="trace-status"></div>
            <div class="trace-list"><table><thead><tr></tr></thead><tbody></tbody></table></div>`;
        this._status = body.querySelector(".trace-status");
        this._list = body.querySelector(".trace-list");
        this._rows = body.querySelector("tbody");
        body.querySelector("thead tr").append(
            ...Columns.map(([text, title]) => {
                const heading = document.createElement("th");
                heading.textContent = text;
                heading.title = title;
                return heading;
            }),
        );
        this._rows.addEventListener("click", (e) => {
            const at = e.target.closest("[data-address]");
            if (at) showCode(Number(at.dataset.address));
        });
        floating.addEventListener("open", () => this.refresh());
    }

    setCpu(cpu) {
        this._cpu = cpu;
        // Disassembles the instruction `_reading` holds from its bytes as they were when it ran.
        this._reading = null;
        this._reader = cpu.disassembler.reading((address) => {
            const { address: start, bytes } = this._reading;
            const offset = (address - start) & 0xffff;
            return offset < bytes.length ? bytes[offset] : cpu.peekmem(address);
        });
        this.refresh();
    }

    /**
     * Shows the instructions the machine ran before now if it is stopped in the debugger, replaying its history
     * a stretch at a time and letting the page go on between them; a later refresh ends one still going.
     */
    async refresh() {
        this._tracing = null;
        if (!this.floating.isOpen || !this._cpu) return;
        if (!this._stopped()) {
            this._show(Running, []);
            return;
        }
        const unavailable = this._unavailable();
        if (unavailable) {
            this._show(unavailable, []);
            return;
        }
        const tracing = recentInstructions(this._history(), TraceDepth);
        this._tracing = tracing;
        let step = tracing.next();
        while (!step.done) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (this._tracing !== tracing || !this._stopped()) return;
            step = tracing.next();
        }
        this._tracing = null;
        const { refusal, entries, stoppedBy } = step.value;
        if (refusal) this._show(refusal, []);
        else this._show(this._describe(entries.length, stoppedBy), entries);
    }

    _describe(count, stoppedBy) {
        if (count === TraceDepth) return `The last ${count} instructions and interrupts, the newest last.`;
        const why = stoppedBy ? `the replay cannot go back past ${stoppedBy}` : "the history goes back no further";
        return `${count} instructions and interrupts, the newest last: ${why}.`;
    }

    _show(status, entries) {
        setText(this._status, status);
        const now = cycleCount(this._cpu);
        const rows = document.createDocumentFragment();
        for (const entry of entries) rows.append(this._row(entry, now));
        this._rows.replaceChildren(rows);
        this._list.hidden = entries.length === 0;
        this._list.scrollTop = this._list.scrollHeight;
    }

    _row(entry, now) {
        const { kind, cycle, address, a, x, y, s, p } = entry;
        const isInstruction = kind === "instruction";
        const row = document.createElement("tr");
        if (!isInstruction) row.className = "trace-interrupt";
        const cell = (text, className) => {
            const td = document.createElement("td");
            td.textContent = text;
            if (className) td.className = className;
            row.append(td);
            return td;
        };
        cell(`-${now - cycle}`, "trace-ago");
        const at = cell(hexword(address), "trace-address");
        at.dataset.address = String(address);
        const name = this._nameOf(address) ?? "";
        cell(name, "trace-name").title = name;
        if (isInstruction) {
            this._reading = entry;
            cell(this._reader.disassemble(address, true)[0], "trace-instruction");
        } else {
            cell(`${kind.toUpperCase()} taken`, "trace-instruction");
        }
        for (const value of [a, x, y, s]) cell(hexbyte(value));
        cell(flagsText(p), "trace-flags");
        return row;
    }
}
