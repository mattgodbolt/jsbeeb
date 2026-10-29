import { byteChar, hexbyte, hexword } from "../hex.js";
import { nameUrl } from "../symbol-sets.js";
import { sheilaBlocks, sheilaName } from "../sheila.js";
import { bindGotoForm, externalLink, FittedRows, labelHtml } from "./debug-dom.js";
import { keyLine } from "./panel-keys.js";

const InitialRows = 16;
const WheelPixelsPerInstruction = 30;

const Writes = /^\*?(?:ST[AXYZ]|SAX|SH[ASXY])\b/;
const ReadModifyWrites = /^\*?(?:ASL|LSR|ROL|ROR|INC|DEC|TSB|TRB|DCP|ISB|RLA|RRA|SLO|SRE)\b/;

/** @returns {("read" | "write")[]} */
function operandAccesses(instruction) {
    if (Writes.test(instruction)) return ["write"];
    if (ReadModifyWrites.test(instruction)) return ["read", "write"];
    return ["read"];
}

function nameTitle({ name, set }, addr) {
    const url = nameUrl(set, name, addr);
    return `${name}: $${hexword(addr)}, from ${set.title}${url ? `\nDefined at ${url}` : ""}`;
}

function showName(node, named, addr) {
    node.classList.add("named");
    node.textContent = named.name;
    node.title = nameTitle(named, addr);
}

function nameNode(named, addr) {
    const url = nameUrl(named.set, named.name, addr);
    const node = url ? externalLink(url, "") : document.createElement("span");
    node.classList.add("symbol");
    showName(node, named, addr);
    return node;
}

/** The disassembly panel's keys; see panel-keys.js for the shape. */
export const DisassemblyKeys = [
    {
        combo: "c",
        key: "c",
        run: "runToCursor",
        label: "run to cursor",
        description: "Run to the highlighted instruction",
    },
    {
        combo: "t",
        key: "t",
        run: "toggleBreakpoint",
        label: "breakpoint",
        description: "Set or clear a breakpoint on the highlighted instruction",
    },
    { combo: "j k", label: "move", description: "Move the highlight down or up" },
    { key: "j", run: "down" },
    { key: "k", run: "up" },
    { combo: "b", key: "b", run: "back", label: "back", description: "Back after clicking a jump target" },
];

/**
 * The disassembly panel: the instructions around a cursor, named from the symbol sets, with the breakpoints set on
 * them. Its keys move the cursor, follow and come back from jumps, and set breakpoints; running the machine is the
 * debugger's, which it asks for through `runToCursor`.
 */
export class DisassemblyView {
    /**
     * @param {object} options
     * @param {import("./floating-panel.js").FloatingPanel} options.floating - its panel, whose keys answer while open
     * @param {import("./panel-keys.js").PanelKeys} options.keys
     * @param {import("./paging-override.js").PagingOverride} options.paging - what it reads memory through
     * @param {() => import("../symbol-names.js").SymbolNames} options.names - the names matched to memory now
     * @param {(text: string) => {address: number, view: string} | undefined} options.resolve - the address a "Go to"
     * text names, and the view to show it in
     * @param {(sets: Set<import("../symbol-names.js").SymbolSet>) => void} options.showing - the sets whose names it
     * shows
     * @param {(address: number) => void} options.showMemory - follows a memory operand
     * @param {(event: MouseEvent, address: number, name: string | undefined) => void} options.offerWatch - offers a
     * right-clicked address as a watch
     * @param {() => void} options.runToCursor
     * @param {() => void} options.refit - redraws it, once its rows have changed in number
     */
    constructor({ floating, keys, paging, names, resolve, showing, showMemory, offerWatch, runToCursor, refit }) {
        this._paging = paging;
        this._names = names;
        this._showing = showing;
        this._showMemory = showMemory;
        this._cpu = null;
        this._sheila = [];
        this._cursor = 0;
        this._cursorRow = Math.floor(InitialRows / 2);
        this._backStack = [];
        this._breakpoints = new Map();
        this._widget = floating.panel.querySelector("#disassembly");
        this._rows = new FittedRows(this._widget, InitialRows, refit);

        bindGotoForm(floating.panel.querySelector(".goto-form"), resolve, ({ address, view }) => {
            this._paging.view = view;
            this.update(address);
        });

        this._widget.addEventListener("click", (e) => {
            if (e.target.closest(".bp_gutter")) this._gutterClick(e);
        });
        this._widget.addEventListener("contextmenu", (e) => {
            const at = Number(e.target.closest(".dis_elem")?.dataset.addr);
            const operand = e.target.closest(".instr_mem_ref, .instr_instr_ref");
            // A watch reads memory as paged, so it takes a name only where the view shows that too.
            const named = (address, name) => offerWatch(e, address, this._paging.differs(address) ? undefined : name);
            if (operand) {
                named(Number(operand.dataset.ref), operand.dataset.name);
            } else if (e.target.closest(".dis_addr")) {
                named(at, this._names().address(at, this._cpu.pc)?.name);
            }
        });
        this._widget.addEventListener("wheel", (evt) => {
            let deltaY = evt.deltaY;
            if (deltaY === 0) return;
            let addr = this._cursor;
            const func = deltaY < 0 ? this._prevInstruction.bind(this) : this._nextInstruction.bind(this);
            deltaY = Math.abs(deltaY);
            while (deltaY > 0) {
                addr = func(addr);
                deltaY -= WheelPixelsPerInstruction;
            }
            this.update(addr);
            evt.preventDefault();
        });

        keys.register({
            table: DisassemblyKeys,
            actions: {
                runToCursor,
                toggleBreakpoint: () => {
                    this._toggleBreakpoint(this._cursor);
                    this.redraw();
                },
                down: () => this.update(this._nextInstruction(this._cursor)),
                up: () => this.update(this._prevInstruction(this._cursor)),
                back: () => {
                    if (this._backStack.length) this.update(this._backStack.pop());
                },
            },
            isLive: () => floating.isOpen,
            panel: floating,
        });
        floating.panel.querySelector(".panel-keys").textContent = keyLine(DisassemblyKeys);
    }

    setCpu(cpu) {
        this._cpu = cpu;
        this._sheila = sheilaBlocks({
            model: cpu.model,
            hasTube: cpu.hasTube,
            hasEconet: !!cpu.econet,
            hasVideoNula: cpu.video.ula.hasVideoNula,
        });
    }

    /** The highlighted instruction's address. */
    get cursor() {
        return this._cursor;
    }

    /** Shows the instructions around `address`, highlighting it in the middle row. */
    update(address) {
        this._draw(address, this._middleRow());
    }

    /** Shows the highlighted instruction again in the row it is in, or the middle row if that row has gone. */
    redraw() {
        this._draw(this._cursor, this._cursorRow < this._rows.rows.length ? this._cursorRow : this._middleRow());
    }

    _middleRow() {
        return Math.floor(this._rows.rows.length / 2);
    }

    _draw(address, cursorRow) {
        this._cursor = address;
        this._cursorRow = cursorRow;
        const { rows } = this._rows;
        const shown = new Set();
        for (let i = cursorRow; i < rows.length; ++i) {
            address = this._showRow(rows[i], address, shown);
        }
        address = this._cursor;
        for (let i = cursorRow - 1; i >= 0; --i) {
            address = this._prevInstruction(address);
            this._showRow(rows[i], address, shown);
        }
        this._showing(shown);
    }

    /** Shows the instruction at `address` in `row`, adding the sets it names to `shown`; returns the next's address. */
    _showRow(row, address, shown) {
        const cpu = this._cpu;
        const names = this._names();
        const [text, end, jumpTarget] = this._paging.disassembler.disassemble(address);
        const bytes = Array.from({ length: end - address }, (_, i) => this._paging.peek(address + i));
        const addrNode = row.querySelector(".dis_addr");
        addrNode.innerHTML = labelHtml(address);
        const named = names.address(address, cpu.pc);
        if (named) {
            addrNode.append(" ", nameNode(named, address));
            shown.add(named.set);
        }
        row.classList.toggle("current", address === cpu.pc && !this._paging.differs(address));
        row.classList.toggle("highlight", address === this._cursor);
        row.querySelector(".instr_bytes").textContent = bytes.map(hexbyte).join(" ");
        row.querySelector(".instr_asc").textContent = bytes.map(byteChar).join("");
        const disNode = row.querySelector(".disassembly");
        disNode.innerHTML = text;
        const accesses = operandAccesses(text);
        for (const ref of disNode.querySelectorAll(".instr_mem_ref, .instr_instr_ref")) {
            const target = parseInt(ref.dataset.ref, 10);
            const operand = names.operand(address, target);
            const register = ref.classList.contains("instr_mem_ref")
                ? sheilaName(this._sheila, target, accesses)
                : undefined;
            // A register's name displaces a MOS's name for it, but not a program's, which says what it is for.
            const inline = register && operand?.set.system ? undefined : operand;
            if (inline) {
                showName(ref, inline, target);
                if (register) ref.title += `\n${register.title}`;
                shown.add(inline.set);
                ref.dataset.name = inline.name;
            } else if (register) {
                const note = document.createElement("span");
                note.className = "note";
                note.textContent = ` ; ${register.name}`;
                note.title = operand ? `${register.title}\n${nameTitle(operand, target)}` : register.title;
                disNode.append(note);
                ref.dataset.name = register.name;
            }
        }
        for (const ref of disNode.querySelectorAll(".instr_mem_ref")) {
            ref.addEventListener("click", (e) =>
                this._showMemory(parseInt(e.target.closest("[data-ref]").dataset.ref, 10)),
            );
        }
        for (const ref of disNode.querySelectorAll(".instr_instr_ref")) {
            ref.addEventListener("click", (e) => this._followJump(e));
        }
        row.querySelector(".bp_gutter").classList.toggle("active", this._breakpoints.has(address));
        row.dataset.addr = address;
        if (jumpTarget !== undefined) {
            row.dataset.ref = jumpTarget;
        } else {
            delete row.dataset.ref;
        }
        return end & 0xffff;
    }

    _prevInstruction(address) {
        // The program counter steers the walk back only where the view shows the code it is running.
        const { pc } = this._cpu;
        return this._paging.disassembler.prevInstruction(address, this._paging.differs(pc) ? undefined : pc);
    }

    _nextInstruction(address) {
        return this._paging.disassembler.nextInstruction(address);
    }

    _followJump(e) {
        const ref = parseInt(e.target.closest("[data-ref]").dataset.ref, 10);
        this._backStack.push(this._cursor);
        this.update(ref);
    }

    _toggleBreakpoint(address) {
        if (this._breakpoints.has(address)) {
            console.log("Removing breakpoint from address " + hexword(address));
            this._breakpoints.get(address).remove();
            this._breakpoints.delete(address);
        } else {
            console.log("Adding breakpoint to address " + hexword(address));
            this._breakpoints.set(
                address,
                this._cpu.debugInstruction.add((x) => x === address),
            );
        }
    }

    _gutterClick(e) {
        const address = parseInt(e.target.closest(".dis_elem").dataset.addr, 10);
        this._toggleBreakpoint(address);
        e.target.closest(".bp_gutter").classList.toggle("active", this._breakpoints.has(address));
    }
}
