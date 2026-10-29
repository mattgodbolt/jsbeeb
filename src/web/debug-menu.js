/**
 * The navbar's Debug menu: into or out of the debugger, the debugger's panels shown or hidden, and
 * every panel that lists itself (see PanelArrangement.listed), ticked while open. It is drawn again
 * each time it opens, so a panel appears in it by being registered with a title.
 */
export class DebugMenu {
    /**
     * @param {object} options
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {import("./debug.js").Debugger} options.dbgr
     */
    constructor({ arrangement, dbgr }) {
        this._arrangement = arrangement;
        this._dbgr = dbgr;
        this._menu = document.getElementById("debug-menu");
        this._debuggerItem = document.getElementById("debugger-toggle");
        this._panelsItem = document.getElementById("debug-views-toggle");
        this._fixed = this._menu.children.length;
        this._debuggerItem.addEventListener("click", (e) => {
            e.preventDefault();
            dbgr.toggleDebugger();
        });
        this._panelsItem.addEventListener("click", (e) => {
            e.preventDefault();
            dbgr.togglePanels();
        });
        document.getElementById("navbarDebug").addEventListener("show.bs.dropdown", () => this.render());
    }

    render() {
        this._debuggerItem.querySelector(".menu-label").textContent = this._dbgr.inDebugger()
            ? "Leave the debugger"
            : "Enter the debugger";
        this._panelsItem.querySelector(".menu-label").textContent = this._dbgr.panelsShown()
            ? "Hide the debug panels"
            : "Show the debug panels";
        while (this._menu.children.length > this._fixed) this._menu.lastElementChild.remove();
        for (const floating of this._arrangement.listed()) {
            const item = document.createElement("a");
            item.href = "#";
            item.className = "dropdown-item panel-item";
            item.dataset.panel = floating.id;
            item.setAttribute("role", "menuitemcheckbox");
            item.setAttribute("aria-checked", String(floating.isOpen));
            item.textContent = floating.title;
            item.addEventListener("click", (e) => {
                e.preventDefault();
                floating.toggle();
            });
            const entry = document.createElement("li");
            entry.append(item);
            this._menu.append(entry);
        }
    }
}
