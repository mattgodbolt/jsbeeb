import {
    basicRom,
    findLine,
    firstStatement,
    holds,
    LanguageRomNumber,
    lineHolding,
    listStatements,
    readPointers,
    readResidentIntegers,
    readVariables,
    romTitle,
    startsStatement,
} from "../basic-state.js";
import { hexword } from "../hex.js";
import { bindGotoForm } from "./debug-dom.js";
import { setText } from "./dom-utils.js";
import { DebugGroup, MenuGroup, panelShell } from "./floating-panel.js";
import { keyLine } from "./panel-keys.js";
import { Centred, StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 260, h: 160 };
const LargestLineNumber = 32767;
const InTube = "BASIC runs in the second processor, whose memory this panel does not read.";

/** The BASIC panel's keys, answering only in the debugger; see panel-keys.js for the shape. */
export const BasicKeys = [
    {
        combo: "s",
        key: "s",
        run: "stepStatement",
        label: "step statement",
        description: "Run to BASIC's next statement",
    },
];

const basicHex = (value) => `&${hexword(value).toUpperCase()}`;

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

/**
 * A floating panel showing BBC BASIC as it runs a program: where the program and its variables are, the line running
 * with its statement marked, and the variables. It can run the machine to a line, or on by a statement, each with a
 * hook on the CPU that lasts only as long as that run.
 */
export class BasicPanel {
    /** Whether the machine runs BBC BASIC: the Atom's BASIC is another language. */
    static fits(cpu) {
        return !cpu.model.isAtom;
    }

    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {import("./panel-keys.js").PanelKeys} options.keys
     * @param {(stopsHere: () => boolean) => void} options.runUntil runs the machine from the debugger until
     * `stopsHere()` holds before an instruction
     * @param {() => boolean} options.inDebugger whether the machine is stopped in the debugger, where its keys answer
     */
    constructor({ cpu, arrangement, keys, runUntil, inDebugger }) {
        this._cpu = cpu;
        this._peek = (address) => cpu.peekmemAsLanguage(address);
        this._runUntil = runUntil;
        /** @type {{bank: number, title: string, basic: ReturnType<typeof basicRom>} | null} */
        this._language = null;
        this._shown = { line: "", variables: "" };
        const { floating, body } = panelShell({
            id: "basic",
            title: "BASIC",
            feature: "basic",
            menuGroup: MenuGroup.software,
            group: DebugGroup,
            place: () => ({ x: Centred, y: StartEdge }),
            minSize: MinPanelSize,
            arrangement,
        });
        this.floating = floating;
        const { panel } = floating;
        panel.classList.add("debug-panel");
        const header = panel.querySelector(".panel-header");
        this._controls = this._makeControls();
        header.querySelector(".panel-close").before(...this._controls);
        body.innerHTML = `
            <div class="basic-absent" hidden></div>
            <div class="basic-present">
                <div class="basic-pointers"></div>
                <div class="basic-line"></div>
                <div class="basic-residents"></div>
                <div class="basic-variables"><table><tbody></tbody></table></div>
                <div class="basic-routines"></div>
                <div class="panel-keys"></div>
            </div>`;
        this._absent = body.querySelector(".basic-absent");
        this._present = body.querySelector(".basic-present");
        this._pointers = body.querySelector(".basic-pointers");
        this._line = body.querySelector(".basic-line");
        this._variables = body.querySelector(".basic-variables tbody");
        this._routines = body.querySelector(".basic-routines");
        this._residents = readResidentIntegers(this._peek).map(({ name }) => {
            const value = element("span", "basic-value", "");
            body.querySelector(".basic-residents").append(element("span", "basic-name", name), value);
            return value;
        });
        body.querySelector(".panel-keys").textContent = keyLine(BasicKeys);

        floating.whileOpen(() => this.update());
        keys.register({
            table: BasicKeys,
            actions: { stepStatement: () => this.stepStatement() },
            isLive: () => inDebugger() && this.floating.isOpen && this._basic() !== null,
            panel: this.floating,
        });
        this.update();
    }

    _makeControls() {
        const form = document.createElement("form");
        form.className = "goto-form";
        form.innerHTML = `<input type="text" class="form-control form-control-sm goto-addr panel-field"
            placeholder="Run to line" aria-label="Run to line" autocomplete="off" />`;
        bindGotoForm(
            form,
            (text) => this._lineNumbered(text),
            (line) => this.runToLine(line.number),
        );
        const step = element("button", "btn btn-sm btn-outline-light basic-step", "Step");
        step.type = "button";
        step.title = "Run to BASIC's next statement (s)";
        step.addEventListener("click", () => this.stepStatement());
        return [form, step];
    }

    /** The language ROM, read again only when another is the language. */
    _currentLanguage() {
        const bank = this._cpu.bankPagedBy(this._peek(LanguageRomNumber));
        const rom = this._cpu.romBank(bank);
        const title = romTitle(rom);
        if (this._language?.bank !== bank || this._language.title !== title)
            this._language = { bank, title, basic: basicRom(rom) };
        return this._language;
    }

    /** BASIC, when it is the language and runs in this machine, or null. */
    _basic() {
        if (this._cpu.hasTube) return null;
        return this._currentLanguage().basic;
    }

    /** Whether BASIC is about to start a statement of its program, and not of a command typed at its prompt. */
    _atProgramStatement({ basic, bank }) {
        const cpu = this._cpu;
        if (cpu.pc !== basic.statementStart || cpu.pagedBank !== bank) return false;
        const { page, top, reading } = readPointers(this._peek);
        return reading > page && reading < top && startsStatement(this._peek, reading);
    }

    _lineNumbered(text) {
        if (!this._basic() || !/^\d+$/.test(text) || Number(text) > LargestLineNumber) return undefined;
        return findLine(this._peek, readPointers(this._peek).page, Number(text)) ?? undefined;
    }

    /** BASIC as it is when a run starts, which the run keeps to should another language take over. */
    _runningBasic() {
        return this._basic() ? this._language : null;
    }

    stepStatement() {
        const running = this._runningBasic();
        if (!running) return;
        this._runUntil(() => this._atProgramStatement(running));
    }

    /**
     * Runs the machine until BASIC comes to line `number`: to its first statement, or to any of its statements from
     * elsewhere, as a procedure defined on it is called. The line is looked for at each statement, as the program can
     * be edited while it runs.
     */
    runToLine(number) {
        const running = this._runningBasic();
        const peek = this._peek;
        const lineNow = () => findLine(peek, readPointers(peek).page, number);
        const isIn = (line, address) => line !== null && holds(line, address);
        let wasInLine = isIn(lineNow(), readPointers(peek).reading);
        this._runUntil(() => {
            if (!this._atProgramStatement(running)) return false;
            const line = lineNow();
            const { reading } = readPointers(peek);
            const cameFromElsewhere = !wasInLine;
            wasInLine = isIn(line, reading);
            return wasInLine && (cameFromElsewhere || reading === firstStatement(peek, line));
        });
    }

    update() {
        const basic = this._basic();
        this._absent.hidden = !!basic;
        this._present.hidden = !basic;
        for (const control of this._controls) control.hidden = !basic;
        if (!basic) {
            this._absent.textContent = this._cpu.hasTube
                ? InTube
                : `The current language is ${this._language.title || "an unnamed ROM"}, not a BASIC this panel can read.`;
            return;
        }
        const peek = this._peek;
        const pointers = readPointers(peek);
        this._pointers.textContent = ["page", "top", "lomem", "himem"]
            .map((name) => `${name.toUpperCase()} ${basicHex(pointers[name])}`)
            .join("  ");
        this._showLine(lineHolding(peek, pointers.page, pointers.reading), pointers.reading, basic.keywords);
        readResidentIntegers(peek).forEach(({ value }, i) => {
            setText(this._residents[i], value);
        });
        this._showVariables(readVariables(peek));
    }

    _showLine(line, reading, keywords) {
        const statements = line ? listStatements(this._peek, line, keywords) : [];
        const running = statements.findIndex(({ from, to }) => reading >= from && reading <= to);
        const shown = JSON.stringify([line?.number, running, statements.map(({ text }) => text)]);
        if (shown === this._shown.line) return;
        this._shown.line = shown;
        if (!line) {
            this._line.replaceChildren(element("span", "basic-idle", "No program line running"));
            return;
        }
        const parts = statements.flatMap(({ text }, i) => [
            ...(i ? [":"] : []),
            element("span", i === running ? "basic-running" : "", text),
        ]);
        this._line.replaceChildren(element("span", "basic-line-number", String(line.number)), ...parts);
    }

    _showVariables({ variables, routines }) {
        const shown = JSON.stringify([variables, routines]);
        if (shown === this._shown.variables) return;
        this._shown.variables = shown;
        this._variables.replaceChildren(
            ...variables.map(({ name, value }) => {
                const row = document.createElement("tr");
                const valueCell = element("td", "basic-value", value);
                valueCell.title = value;
                row.append(element("td", "basic-name", name), valueCell);
                return row;
            }),
        );
        this._routines.textContent = routines.join(" ");
    }
}
