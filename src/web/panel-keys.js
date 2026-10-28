/**
 * The keys that windows answer while the machine is stopped. Each window declares a table of its
 * keys, in the shape of the Shortcuts table: a row with a `key` runs the action its `run` names;
 * a row with a `description` documents the keys its `combo` names, space separated, for Help, and
 * a `label` puts them on the window's own line of keys. A row with no description is documented
 * by another row naming its key.
 */
export class PanelKeys {
    /** @param {import("./floating-panel.js").PanelArrangement} arrangement whose stacking decides between windows */
    constructor(arrangement) {
        this._arrangement = arrangement;
        this._owners = [];
    }

    /**
     * @param {object} owner
     * @param {object[]} owner.table
     * @param {Object<string, function(): void>} owner.actions what each row's `run` names
     * @param {function(): boolean} owner.isLive whether its keys answer now
     * @param {import("./floating-panel.js").FloatingPanel | null} owner.panel the window offering them, or null
     * for keys that yield to any window's
     */
    register(owner) {
        this._owners.push(owner);
    }

    /**
     * Runs what `key` is bound to by the live owner offering it whose window is in front.
     * @returns {boolean} whether anything was bound to it
     */
    press(key) {
        const offering = this._owners.filter((owner) => owner.isLive() && owner.table.some((row) => row.key === key));
        if (offering.length === 0) return false;
        const front = this._arrangement.frontmost(offering.map((owner) => owner.panel));
        const owner = offering.find((candidate) => candidate.panel === front);
        owner.actions[owner.table.find((row) => row.key === key).run]();
        return true;
    }
}

const documented = (table) => table.filter((row) => row.description);

/** A window's line of keys, as "j/k move · b back". */
export function keyLine(table) {
    return documented(table)
        .filter((row) => row.label)
        .map((row) => `${row.combo.replaceAll(" ", "/")} ${row.label}`)
        .join(" · ");
}

/** The description of the action `run` names in `table`, and the keys that do it, for a button's tooltip. */
export function describeAction(table, run) {
    const { key } = table.find((row) => row.run === run);
    const { description } = documented(table).find((row) => row.combo.split(" ").includes(key));
    return `${description} (${key})`;
}

/** Help's rows for `tables`: each documented combo, its keys as key caps, and what they do. */
export function helpRows(tables) {
    return tables.flatMap(documented).map(({ combo, description }) => {
        const row = document.createElement("tr");
        const keys = document.createElement("td");
        combo.split(" ").forEach((key, index) => {
            const cap = document.createElement("span");
            cap.className = "key";
            cap.textContent = key;
            keys.append(...(index ? [" ", cap] : [cap]));
        });
        const what = document.createElement("td");
        what.textContent = description;
        row.append(keys, what);
        return row;
    });
}
