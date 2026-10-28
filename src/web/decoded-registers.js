import { hexbyte, hexword } from "../hex.js";

/**
 * @typedef {object} Meaning one piece of what a register's value means
 * @property {string} text
 * @property {string} title
 * @property {boolean} [lit] for a named bit or line, whether it is active; absent for a value spelt out
 */

/**
 * @template State
 * @typedef {object} DecodedRegister
 * @property {string} name
 * @property {string} title what the register is
 * @property {8 | 16} bits
 * @property {(state: State) => number} value
 * @property {(value: number, state: State) => Meaning[]} decode
 */

/**
 * @template State
 * @typedef {object} RegisterSection
 * @property {string} heading
 * @property {DecodedRegister<State>[]} registers
 */

/**
 * Registers shown as hex beside what their values mean, for the panels that show a peripheral decoded. The owner reads
 * the peripheral once into a state object and passes it to `update`, which touches only the rows whose meaning changed.
 * @template State
 */
export class DecodedRegisters {
    /**
     * @param {HTMLElement} container
     * @param {RegisterSection<State>[]} sections
     */
    constructor(container, sections) {
        this._rows = [];
        const table = document.createElement("table");
        table.className = "decoded-registers";
        for (const { heading, registers } of sections) {
            const body = document.createElement("tbody");
            const headingRow = body.insertRow();
            headingRow.className = "decoded-heading";
            const headingCell = document.createElement("th");
            headingCell.colSpan = 3;
            headingCell.textContent = heading;
            headingRow.append(headingCell);
            for (const register of registers) {
                const row = body.insertRow();
                const name = document.createElement("th");
                name.textContent = register.name;
                name.title = register.title;
                const hex = row.insertCell();
                hex.className = "decoded-hex";
                const meaning = row.insertCell();
                meaning.className = "decoded-meaning";
                row.prepend(name);
                this._rows.push({ register, hex, meaning, shown: "" });
            }
            table.append(body);
        }
        container.append(table);
    }

    /** @param {State} state */
    update(state) {
        for (const row of this._rows) {
            const { register } = row;
            const value = register.value(state);
            const hex = register.bits === 16 ? hexword(value) : hexbyte(value);
            if (row.hex.textContent !== hex) row.hex.textContent = hex;
            const meanings = register.decode(value, state);
            const shown = meanings.map(({ text, lit }) => `${text}\u0000${lit}`).join("\u0001");
            if (shown === row.shown) continue;
            row.shown = shown;
            row.meaning.replaceChildren(...meanings.map(meaningNode));
        }
    }
}

function meaningNode({ text, title, lit }) {
    const node = document.createElement("span");
    node.className = lit === undefined ? "decoded-value" : `decoded-bit${lit ? " lit" : ""}`;
    node.textContent = text;
    node.title = title;
    return node;
}

/**
 * Decodes a register of flags, most significant first, each lit while its bit is set.
 * @param {({name: string, title: string} | null)[]} names by bit number; null for a bit with no meaning
 * @returns {(value: number) => Meaning[]}
 */
export function namedBits(names) {
    return (value) =>
        names
            .map((named, bit) => named && { text: named.name, title: named.title, lit: !!(value & (1 << bit)) })
            .filter((meaning) => meaning !== null)
            .reverse();
}
