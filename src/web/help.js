import * as bootstrap from "bootstrap";

import { MemoryKeys, ToolbarKeys } from "./debug.js";
import { DisassemblyKeys } from "./disassembly-view.js";
import { PauseKeys } from "./keyboard-setup.js";
import { helpRow, helpRows } from "./panel-keys.js";
import { Shortcuts } from "./shortcuts.js";

/** Help's blocks on its debugging tab, one for each window's keys; a window with keys of its own adds itself here. */
const KeyTables = [
    ["Paused", PauseKeys],
    ["Debugger", ToolbarKeys],
    ["Disassembly", DisassemblyKeys],
    ["Memory", MemoryKeys],
];
const StartTab = "help-start";
const DebuggingTab = "help-debugging";

const tabButton = (paneId) => document.querySelector(`#help [data-bs-target="#${paneId}"]`);

/** Fills Help's tables of keys from the tables that bind them. */
export function fillHelp() {
    document.getElementById("shortcuts-help").append(...Shortcuts.map((row) => helpRow([row.combo], row.description)));
    document.getElementById("debug-keys-help").append(
        ...KeyTables.map(([title, table]) => {
            const block = document.createElement("section");
            block.className = "col-lg-6";
            const heading = document.createElement("h6");
            heading.textContent = title;
            const rows = document.createElement("table");
            rows.className = "table table-sm";
            rows.createTBody().append(...helpRows([table]));
            block.append(heading, rows);
            return block;
        }),
    );
}

/**
 * Opens Help on its debugging tab while the machine is stopped, and otherwise on the tab last chosen.
 * @param {function(): boolean} isStopped
 */
export function openHelpOnTheTabForNow(isStopped) {
    let chosen = StartTab;
    const help = document.getElementById("help");
    help.addEventListener("click", (event) => {
        const pane = event.target.closest("[data-bs-toggle='tab']")?.dataset.bsTarget;
        if (pane) chosen = pane.slice(1);
    });
    help.addEventListener("show.bs.modal", () => {
        bootstrap.Tab.getOrCreateInstance(tabButton(isStopped() ? DebuggingTab : chosen)).show();
    });
}
