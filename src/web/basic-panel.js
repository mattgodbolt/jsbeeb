import {
    basicRom,
    findLine,
    firstStatement,
    holds,
    languageRomNumber,
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
import { DebugGroup, FloatingPanel, panelShell } from "./floating-panel.js";
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
        this._peek = (address) => cpu.peekmem(address);
        this._runUntil = runUntil;
        /** @type {{bank: number, title: string, basic: ReturnType<typeof basicRom>} | null} */
        this._language = null;
        this._shown = { line: "", variables: "" };
        const { panel, body } = panelShell({ id: "basic", title: "BASIC", feature: "basic" });
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

        this.floating = new FloatingPanel({
            panel,
            id: "basic",
            title: "BASIC",
            group: DebugGroup,
            place: () => ({ x: Centred, y: StartEdge }),
            minSize: MinPanelSize,
            reopens: true,
            arrangement,
        });
        const refresh = arrangement.refreshing(
            () => this.floating.isOpen,
            () => this.update(),
        );
        this.floating.addEventListener("open", () => refresh.drawNow());
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
            (line) => this.runToLine(line),
        );
        const step = element("button", "btn btn-sm btn-outline-light basic-step", "Step");
        step.type = "button";
        step.title = "Run to BASIC's next statement (s)";
        step.addEventListener("click", () => this.stepStatement());
        return [form, step];
    }

    /** The language ROM, read again only when another is the language. */
    _currentLanguage() {
        const bank = this._cpu.bankPagedBy(languageRomNumber(this._peek));
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
    _atProgramStatement() {
        const { basic, bank } = this._language;
        const cpu = this._cpu;
        if (cpu.pc !== basic.statementStart || cpu.pagedBank !== bank) return false;
        const { page, top, reading } = readPointers(this._peek);
        return reading > page && reading < top && startsStatement(this._peek, reading);
    }

    _lineNumbered(text) {
        if (!this._basic() || !/^\d+$/.test(text) || Number(text) > LargestLineNumber) return undefined;
        return findLine(this._peek, readPointers(this._peek).page, Number(text)) ?? undefined;
    }

    stepStatement() {
        if (!this._basic()) return;
        this._runUntil(() => this._atProgramStatement());
    }

    /**
     * Runs the machine until BASIC comes to `line`: to its first statement, or to any of its statements from elsewhere,
     * as a procedure defined on it is called.
     * @param {import("../basic-state.js").ProgramLine} line
     */
    runToLine(line) {
        const first = firstStatement(this._peek, line);
        let wasInLine = holds(line, readPointers(this._peek).reading);
        this._runUntil(() => {
            if (!this._atProgramStatement()) return false;
            const { reading } = readPointers(this._peek);
            const cameFromElsewhere = !wasInLine;
            wasInLine = holds(line, reading);
            return wasInLine && (cameFromElsewhere || reading === first);
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
            if (this._residents[i].textContent !== value) this._residents[i].textContent = value;
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
