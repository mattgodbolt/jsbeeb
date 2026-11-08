import { hexword } from "../hex.js";
import { cpuMoment, cycleCount } from "../lockstep.js";
import { bankName } from "../paging.js";
import { durationText } from "../replay.js";
import { setText, textButton } from "./dom-utils.js";
import { DebugGroup, MenuGroup, panelShell } from "./floating-panel.js";
import { StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 300, h: 80 };
const WhileRunning = "The call stack shows while the machine is stopped.";
const Searching = "Searching back for older calls…";
const NoFrames = "Not inside any call or interrupt.";
const PredatesHistory = "Older calls predate the history.";
const EntryTitles = {
    JSR: "A JSR called this routine",
    BRK: "A BRK entered this handler",
    IRQ: "An IRQ was taken into this handler",
    NMI: "An NMI was taken into this handler",
};

/** The line under the frames saying why there are none older, if the stack is not accounted for without them. */
function endText({ frames, accounted, txsAt, stoppedBy }) {
    if (accounted && txsAt !== null)
        return `The TXS at $${hexword(txsAt)} moved the stack; calls before it are not followed.`;
    if (accounted) return frames.length ? "" : NoFrames;
    return stoppedBy ? `Older calls are not shown: the search cannot go back past ${stoppedBy}.` : PredatesHistory;
}

/**
 * The Call stack panel: the calls and interrupts the machine is inside, innermost first, found by searching back
 * through the history step back keeps (see ReplayHistory's callStack) each time the machine stops somewhere new.
 * The search lets the page go on between stretches, showing the frames found so far, and ends once the machine
 * moves or the panel closes.
 */
export class CallStackPanel {
    /**
     * @param {object} options
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {() => string | null} options.refusal - why the history cannot be searched, or null if it can
     * @param {() => Generator} options.search - a ReplayHistory callStack search
     * @param {() => boolean} options.isStopped
     * @param {(address: number, bank: number | undefined) => string | undefined} options.nameOf - the name the
     * debugger gives an address, in sideways `bank` if it is in one
     * @param {(address: number, bank: number | undefined) => void} options.showCode - in `bank`, or as paged
     */
    constructor({ arrangement, refusal, search, isStopped, nameOf, showCode }) {
        this._refusal = refusal;
        this._search = search;
        this._isStopped = isStopped;
        this._nameOf = nameOf;
        this._showCode = showCode;
        this._cpu = null;
        this._searching = null;
        this._shownAt = null;
        this._frames = [];
        /** @type {{name: HTMLElement, address: number, bank: number | undefined}[]} */
        this._named = [];
        const { floating, body } = panelShell({
            id: "callstack",
            title: "Call stack",
            feature: "callstack",
            menuGroup: MenuGroup.cpu,
            group: DebugGroup,
            place: () => ({ x: StartEdge, y: { ...StartEdge, attach: { to: "memory", side: "after" } } }),
            minSize: MinPanelSize,
            arrangement,
        });
        this.floating = floating;
        this.panel = floating.panel;
        body.innerHTML = `<table class="cs-frames"><tbody></tbody></table><div class="cs-end"></div>`;
        this._list = body.querySelector("tbody");
        this._end = body.querySelector(".cs-end");
        floating.whileOpen(() => this.update());
        floating.addEventListener("close", () => this._forget());
    }

    setCpu(cpu) {
        this._cpu = cpu;
        this._forget();
        if (this.floating.isOpen) this.update();
    }

    /** Searches afresh if the machine has stopped somewhere new since the last search began. */
    update() {
        if (!this._cpu) return;
        if (!this._isStopped()) {
            this._forget();
            this._show([], WhileRunning);
            return;
        }
        const moment = cpuMoment(this._cpu);
        if (moment === this._shownAt) return;
        this._forget();
        this._shownAt = moment;
        const refusal = this._refusal();
        if (refusal) this._show([], refusal);
        else this._run(this._search());
    }

    /** Names the frames shown again, as the names the debugger knows change. */
    renamed() {
        for (const { name, address, bank } of this._named) this._name(name, address, bank);
    }

    _forget() {
        this._searching?.return();
        this._searching = null;
        this._shownAt = null;
    }

    async _run(searching) {
        this._searching = searching;
        let step = searching.next();
        while (!step.done) {
            this._show(step.value, Searching);
            await new Promise((resolve) => setTimeout(resolve, 0));
            // A machine that has moved on is searched afresh as the panel is next drawn.
            if (this._searching !== searching || cpuMoment(this._cpu) !== this._shownAt) return;
            step = searching.next();
        }
        this._searching = null;
        const found = step.value;
        if (found.refusal) this._show([], found.refusal);
        else this._show(found.frames, endText(found));
    }

    // A search's frames only grow, so those already shown keep their rows, and a click on one lands.
    _show(frames, endLine) {
        const kept = this._frames.length <= frames.length && this._frames.every((frame, i) => frame === frames[i]);
        if (!kept) {
            this._list.replaceChildren();
            this._frames = [];
            this._named = [];
        }
        const added = frames.slice(this._frames.length);
        this._frames.push(...added);
        this._list.append(...added.map((frame) => this._row(frame)));
        setText(this._end, endLine);
        this._end.hidden = endLine === "";
    }

    _row({ kind, cycle, site, siteBank, routine, routineBank }) {
        const row = document.createElement("tr");
        const ago = cycleCount(this._cpu) - cycle;
        const seconds = durationText(ago / this._cpu.model.cyclesPerSecond);
        row.title = `${EntryTitles[kind]} ${ago} cycles (${seconds}) ago`;
        const cell = (className, ...content) => {
            const td = document.createElement("td");
            td.className = className;
            td.append(...content);
            row.append(td);
        };
        cell("cs-kind", kind);
        cell("cs-routine", ...this._place(routine, routineBank));
        cell("cs-site", "from ", ...this._place(site, siteBank));
        return row;
    }

    // Cut short to fit, so in full in its tooltip.
    _name(name, address, bank) {
        const text = this._nameOf(address, bank) ?? "";
        setText(name, text);
        name.title = text;
    }

    // `address` as a button showing its code, with its name and its bank, if any.
    _place(address, bank) {
        const where = `$${hexword(address)}`;
        const button = textButton("cs-address", where, `Show the code at ${where}`);
        button.addEventListener("click", () => this._showCode(address, bank));
        const name = document.createElement("span");
        name.className = "cs-name";
        this._name(name, address, bank);
        this._named.push({ name, address, bank });
        if (bank === undefined) return [button, name];
        const inBank = document.createElement("span");
        inBank.className = "cs-bank";
        inBank.textContent = `bank ${bankName(bank)}`;
        return [button, name, inBank];
    }
}
