import { hexword } from "../hex.js";
import { machineSheilaBlocks, sheilaName, sheilaRegister } from "../sheila.js";
import { tightLoopAt } from "../tight-loop.js";
import { DebugGroup } from "./floating-panel.js";

/** The decoded panel, by id, of each SHEILA device that has one, by its block's `device`. */
const DevicePanels = { SysVIA: "sysvia", UserVIA: "uservia" };

function loopAddresses({ start, end }) {
    return start === end ? `$${hexword(start)}` : `$${hexword(start)}-$${hexword(end)}`;
}

/** `nodes` listed as in prose: "a", "a and b", "a, b and c". */
function inProse(nodes) {
    return nodes.flatMap((node, i) => (i === 0 ? [node] : [i < nodes.length - 1 ? ", " : " and ", node]));
}

/**
 * A line saying, while the machine is stopped in a tight loop, where the loop is and what it polls, by its SHEILA
 * register's name where it has one, with a button to open each polled device's decoded panel.
 */
export class TightLoopNote {
    /**
     * @param {HTMLElement} line
     * @param {import("./floating-panel.js").PanelArrangement} arrangement
     */
    constructor(line, arrangement) {
        this._line = line;
        this._arrangement = arrangement;
        this._cpu = null;
        this._sheila = [];
    }

    /** @param {import("../6502.js").Cpu6502} cpu */
    setCpu(cpu) {
        this._cpu = cpu;
        this._sheila = machineSheilaBlocks(cpu);
    }

    /** Shows the tight loop the machine is stopped in, if it is in one. */
    show() {
        const loop = tightLoopAt(this._cpu.disassembler, this._cpu.pc);
        if (!loop) return this.clear();
        const reads = loop.reads.map((address) => this._polled(address));
        const panels = new Map(reads.flatMap(({ panel, block }) => (panel ? [[panel, block]] : [])));
        const polling = reads.length
            ? [" polling ", ...inProse(reads.map(({ node }) => node))]
            : [" that reads nothing"];
        this._line.hidden = false;
        this._line.replaceChildren(
            `In a loop at ${loopAddresses(loop)}`,
            ...polling,
            ...[...panels].flatMap(([panel, block]) => [" ", this._opener(panel, block)]),
        );
    }

    clear() {
        this._line.hidden = true;
        this._line.replaceChildren();
    }

    _polled(address) {
        const node = document.createElement("span");
        node.className = "polled";
        const found = sheilaRegister(this._sheila, address, "read");
        const named = sheilaName(this._sheila, address, ["read"]);
        node.textContent = named ? `${named.name} ($${hexword(address)})` : `$${hexword(address)}`;
        if (named) node.title = named.title;
        const id = found && DevicePanels[found.block.device];
        const panel = id && this._arrangement.panelsIn(DebugGroup).find((floating) => floating.id === id);
        return { node, panel, block: found?.block };
    }

    _opener(floating, block) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "txt-btn";
        button.tabIndex = -1;
        button.textContent = `open ${block.title}`;
        button.addEventListener("click", () => {
            floating.open();
            this._arrangement.raise(floating);
        });
        return button;
    }
}
