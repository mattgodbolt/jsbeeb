import { downloadBlob } from "./dom-utils.js";
import { byteChar, hexbyte, hexword, parseAddr } from "../hex.js";
import { NoNames } from "../symbol-names.js";
import { isHttps } from "../symbol-sets.js";
import { noteFeature } from "./analytics.js";
import { dismissToast, toast } from "./toast.js";
import { WatchPanel } from "./watch-panel.js";
import { RunMode } from "./emulation-loop.js";
import { DebugGroup, FloatingPanel, MenuGroup } from "./floating-panel.js";
import { EndEdge, Gap, StartEdge } from "./panel-layout.js";
import { keyLine } from "./panel-keys.js";
import { cpuMoment, cycleCount, stateHash } from "../lockstep.js";
import { durationText, notDeeper } from "../replay.js";
import { NumRomBanks } from "../6502.js";
import { describeHit } from "../breakpoints.js";
import { sheilaAddress, machineSheilaBlocks } from "../sheila.js";
import { BreakpointsPanel } from "./breakpoints-panel.js";
import { bindGotoForm, externalLink, FittedRows, labelHtml, powerOfTwoColumnsThatFit } from "./debug-dom.js";
import { DisassemblyView } from "./disassembly-view.js";
import { PagingOverride } from "./paging-override.js";
import {
    bankName,
    bankView,
    PagedView,
    parseViewedAddress,
    peekViewed,
    screenView,
    SidewaysEnd,
    SidewaysStart,
    viewedBank,
    viewsFor,
} from "../paging.js";
import { Dropdown } from "bootstrap";
import { TightLoopNote } from "./tight-loop-note.js";
import { readStored, writeStored } from "./stored-json.js";

const noop = () => {};

const LabelDrop = {
    dropWhat: "Drop a label file",
    dropInto: "BeebAsm, VICE or b-em labels name addresses in the debugger",
};

const InitialMemoryRows = 16;
const FewestBytesPerRow = 8;
const MemoryPageRows = 8;
const QuickRunsPerSecond = 50;
const ResetVector = 0xfffc;
const NeverFallsThrough = new Set(["jump", "return", "interrupt"]);
const HexByte = /^[0-9a-f]{1,2}$/i;
const NoHistory = "There is nothing to step back to here.";
const NoStepBackInSession = "Step back is not available in a shared session.";
const NoSearchInSession = "Searching back is not available in a shared session.";
const NoHistoryToSearch = "There is no history to search back through here.";
const MovedSinceSearch = "The machine has moved on since that search; search again to step back to a write.";
const StepBackRuns = ["stepBack", "stepBackOver", "stepBackOut"];
// What a search back resolves to when a later one ended it.
const Ended = Symbol("ended");

function sourceNode(source) {
    return isHttps(source) ? externalLink(source, "source") : document.createTextNode(source);
}

function homeNodes(home) {
    if (!isHttps(home)) return [];
    return [externalLink(home, new URL(home).hostname.replace(/^www\./, "")), ", "];
}

function addressFor(names, text, pc) {
    return names.addressOf(text, pc) ?? parseAddr(text);
}

function memoryTitle(address, named, inRegion) {
    const lines = [named ? `${named.name}: $${hexword(address)}` : `$${hexword(address)}`];
    if (inRegion) {
        const { region, set } = inRegion;
        lines.push(`in ${region.name}, $${hexword(region.start)}-$${hexword(region.end - 1)}, from ${set.title}`);
    }
    return lines.join("\n");
}

class MemoryView {
    /**
     * @param {HTMLElement} widget
     * @param {PagingOverride} paging - what it reads memory through
     * @param {() => {names: import("../symbol-names.js").SymbolNames, pc: number}} naming
     * @param {(sets: Set<import("../symbol-names.js").SymbolSet>) => void} showing - the sets whose names it shows
     * @param {() => void} redraw - redraws it, once its rows have changed in number or width
     */
    constructor(widget, paging, naming, showing, redraw) {
        this._widget = widget;
        this._paging = paging;
        this._naming = naming;
        this._showing = showing;
        this._addr = 0;
        this._first = 0;
        this._prevSnapshot = new Uint8Array(65536);
        this._snapshotView = PagedView;
        this._rows = new FittedRows(widget, InitialMemoryRows, redraw);
        this._setBytesPerRow(FewestBytesPerRow);

        new ResizeObserver(([entry]) => {
            const row = this._rows.rows[0];
            const [address, bytes, text] = [".dis_addr", ".mem_bytes", ".mem_asc"].map((selector) =>
                row.querySelector(selector).getBoundingClientRect(),
            );
            const bytesWidth = bytes.width + text.width;
            // Zero while the panel is hidden.
            if (bytesWidth === 0) return;
            const perRow = powerOfTwoColumnsThatFit(
                entry.contentRect.width,
                text.right - address.left - bytesWidth,
                bytesWidth / this._bytesPerRow,
                FewestBytesPerRow,
            );
            if (perRow === this._bytesPerRow) return;
            this._setBytesPerRow(perRow);
            redraw();
        }).observe(widget);

        widget.addEventListener("wheel", (evt) => {
            const deltaY = evt.deltaY;
            if (deltaY === 0) return;
            this.step((deltaY / 20) | 0);
            evt.preventDefault();
        });
    }

    _setBytesPerRow(bytes) {
        this._bytesPerRow = bytes;
        this._widget.style.setProperty("--bytes", `${bytes}`);
    }

    /** Gives `row` a span per byte in each column, unless it has them for the current width. */
    _shapeRow(row) {
        const [hex, text] = [row.querySelector(".mem_bytes"), row.querySelector(".mem_asc")];
        if (hex.childElementCount === this._bytesPerRow) return;
        const spans = () => Array.from({ length: this._bytesPerRow }, () => document.createElement("span"));
        hex.replaceChildren(...spans().flatMap((span, i) => (i ? [" ", span] : [span])));
        text.replaceChildren(...spans());
    }

    update(maybeNewAddr) {
        if (maybeNewAddr !== undefined) this._addr = maybeNewAddr & 0xffff;
        const perRow = this._bytesPerRow;
        const targetRow = this._addr & -perRow;
        let addr = targetRow - perRow * this._rows.anchor;
        if (addr < 0) addr = 0;
        this._first = addr;
        const { names, pc } = this._naming();
        const shown = new Set();
        for (const row of this._rows.rows) {
            this._shapeRow(row);
            row.querySelector(".dis_addr").innerHTML = labelHtml(addr);
            row.classList.toggle("highlight", addr === targetRow);
            const dump = this.dump(addr, addr + perRow);
            const bytes = row.querySelectorAll(".mem_bytes span");
            const ascii = row.querySelectorAll(".mem_asc span");
            for (let i = 0; i < perRow; ++i) {
                const address = (addr + i) & 0xffff;
                const inRegion = names.regionAt(address);
                const named = names.address(address, pc);
                if (inRegion) shown.add(inRegion.set);
                if (named) shown.add(named.set);
                bytes[i].textContent = dump.hex[i];
                ascii[i].textContent = dump.asc[i];
                for (const span of [bytes[i], ascii[i]]) {
                    span.dataset.addr = address;
                    span.classList.toggle("changed", dump.changed[i]);
                    span.classList.toggle("target", address === this._addr);
                    span.classList.toggle("region", !!inRegion);
                    span.classList.toggle("region-start", inRegion?.region.start === address);
                    span.title = inRegion || named ? memoryTitle(address, named, inRegion) : "";
                }
            }
            addr = (addr + perRow) & 0xffff;
        }
        this._showing(shown);
    }

    // TODO(#1062) extract memory part from view part and reuse in disassembler etc. also peekmem can go then
    dump(from, to) {
        const hex = [];
        const asc = [];
        const changed = [];
        // Changes are marked only against a snapshot taken in the view shown.
        const comparable = this._snapshotView === this._paging.view;
        for (let i = from; i < to; ++i) {
            const b = this._paging.peek(i);
            hex.push(hexbyte(b));
            changed.push(comparable && i < this._prevSnapshot.length && this._prevSnapshot[i] !== b);
            asc.push(byteChar(b));
        }
        return { hex: hex, asc: asc, changed: changed };
    }

    snapshot() {
        this._snapshotView = this._paging.view;
        for (let i = 0; i < 65536; ++i) {
            this._prevSnapshot[i] = this._paging.peek(i);
        }
    }

    /** Moves it on by `rows` of its current width, back for a negative number. */
    step(rows) {
        this.update(this._addr + rows * this._bytesPerRow);
    }

    /** The first and last addresses it shows, the last no further than $ffff. */
    shown() {
        return {
            from: this._first,
            to: Math.min(0xffff, this._first + this._rows.rows.length * this._bytesPerRow - 1),
        };
    }

    _byteAt(address) {
        return this._widget.querySelector(`.mem_bytes [data-addr="${address}"]`);
    }

    /**
     * Puts a field over the byte at `address`, bringing it into view if need be. Tab hands `write` its new value and
     * `editNext` the next byte's address (Shift-Tab, the one before's); Enter hands it over and leaves, and Escape just
     * leaves. A value left as it was is not handed over, as a write to a register is not the same as leaving it alone.
     */
    edit(address, write, editNext) {
        if (!this._byteAt(address)) this.update(address);
        const byte = this._byteAt(address);
        const field = document.createElement("input");
        field.className = "mem-edit panel-field";
        field.maxLength = 2;
        field.autocomplete = "off";
        field.spellcheck = false;
        field.setAttribute("aria-label", `New value for $${hexword(address)}`);
        const was = byte.textContent;
        field.value = was;
        byte.replaceChildren(field);
        field.addEventListener("blur", () => this.update(), { once: true });
        field.addEventListener("input", () => field.classList.remove("is-invalid"));
        field.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" && e.key !== "Tab") return;
            e.preventDefault();
            const value = HexByte.test(field.value) ? parseInt(field.value, 16) : undefined;
            field.classList.toggle("is-invalid", value === undefined);
            if (value === undefined) return;
            field.blur();
            if (value !== parseInt(was, 16)) write(address, value);
            if (e.key === "Tab") editNext((address + (e.shiftKey ? -1 : 1)) & 0xffff);
        });
        field.focus();
        field.select();
    }
}

/** The keys of the debugger's toolbar, answering only in the debugger; see panel-keys.js for the shape. */
export const ToolbarKeys = [
    { combo: "g", key: "g", run: "go", label: "run", description: "Resume running" },
    {
        combo: "n N",
        label: "step",
        description: "Step one instruction (N: one clock cycle)",
    },
    { key: "n", run: "step" },
    { key: "N", run: "stepCycle" },
    {
        combo: "p P",
        label: "step back",
        description: "Step back one instruction (P: back over the call just returned from)",
    },
    { key: "p", run: "stepBack" },
    { key: "P", run: "stepBackOver" },
    {
        combo: "m",
        key: "m",
        run: "stepOver",
        label: "step over",
        description: "Step over a call, or a loop from its backward branch",
    },
    {
        combo: "o O",
        label: "step out",
        description:
            "Run until this subroutine or interrupt handler returns (O: back to the call or interrupt that entered it)",
    },
    { key: "o", run: "stepOut" },
    { key: "O", run: "stepBackOut" },
    { combo: "v", key: "v", run: "runToVsync", label: "vsync", description: "Run to the start of the next vsync" },
];

export const MemoryKeys = [
    {
        combo: "u i U I",
        label: "±1, ±8 rows",
        description: "Memory forward (u, U) or back (i, I), one row or eight",
    },
    { key: "u", run: "forward" },
    { key: "i", run: "back" },
    { key: "U", run: "pageForward" },
    { key: "I", run: "pageBack" },
];

const RememberedPanelsKey = "debugPanels";
const BrowserStorage = () => window.localStorage;
const MinPanelWidth = 220;
const DisassemblyWidth = 400;
/**
 * In px, the narrowest each side's gutter can be for its panels to go in it by default: the left's for memory's
 * rows, the right's for a disassembly line with a named operand. Narrower, they go at their own widths, against
 * the window's edge.
 */
const ColumnWidthNeeded = { left: 280, right: DisassemblyWidth };
const StackBytesShown = 8;
const WholeNumber = /^\d+$/;
const RunningNameMatchMs = 1000;
const below = (id) => ({ ...StartEdge, attach: { to: id, side: "after" } });

/**
 * The debugger's own panels, each `#<id>-panel` in the page, in the order they open, so that each opens after the
 * panel it sits under. `side` and `place` are where it goes until the user arranges it: down the right of the
 * screen, or down its left. `show` brings it up to date with the machine, the disassembly at `at`.
 */
const OwnPanels = [
    {
        id: "toolbar",
        title: "Debugger toolbar",
        minSize: { w: 200, h: 30 },
        side: "right",
        place: { x: EndEdge, y: StartEdge },
        show: noop,
    },
    {
        id: "disassembly",
        title: "Disassembly",
        minSize: { w: MinPanelWidth, h: 120 },
        side: "right",
        place: { x: EndEdge, y: below("toolbar") },
        naturalWidth: DisassemblyWidth,
        show: (dbgr, at) => dbgr.updateDisassembly(at),
    },
    {
        id: "registers",
        title: "Registers",
        minSize: { w: 150, h: 60 },
        side: "right",
        place: { x: EndEdge, y: below("disassembly") },
        show: (dbgr) => dbgr.updateRegisters(),
    },
    {
        id: "memory",
        title: "Memory",
        minSize: { w: MinPanelWidth, h: 100 },
        side: "left",
        place: { x: StartEdge, y: StartEdge },
        show: (dbgr) => dbgr.updateMemory(),
    },
];

/** Of the panels `ids`, those that were open when the debugger's were last seen. */
function rememberedPanels(ids) {
    const remembered = readStored(BrowserStorage, RememberedPanelsKey, "which debug panels were open");
    return Array.isArray(remembered) ? ids.filter((id) => remembered.includes(id)) : [];
}

function rememberPanels(ids) {
    writeStored(BrowserStorage, RememberedPanelsKey, ids, "which debug panels were open");
}

/**
 * The debugger: its panels (a toolbar, disassembly, memory and registers), their
 * keys, and running the machine to a stop. The panels open on entering the debugger, stay open
 * and keep up with the machine once it runs again, and close on leaving it with Alt-S. They read
 * the machine once a frame while it runs, and only while open, and nothing they read changes it.
 */
export class Debugger {
    /**
     * @param {object} options
     * @param {import("../symbol-sets.js").SymbolSets | null} options.symbolSets - where names for addresses come from
     * @param {import("../label-files.js").LabelFiles} options.labelFiles - the user's own names, ahead of the sets'
     * @param {import("./panel-keys.js").PanelKeys} options.keys - where the panels' keys are routed from
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement - what places its panels
     * @param {HTMLElement} options.monitor - the monitor around the screen, which shows when a click finds a byte
     * @param {(() => Storage) | null} options.breakpointStorage - where breakpoints are kept between visits, or null
     * to keep them only for this visit
     */
    constructor({ symbolSets, labelFiles, keys, arrangement, monitor, breakpointStorage }) {
        this._arrangement = arrangement;
        this._monitor = monitor;
        this.patchInstructions = new Map();
        this._loop = null;
        /** @type {import("../replay.js").ReplayHistory | null} */
        this._history = null;
        this._runningTo = null;
        // On the scheduler's clock, which a power-on reset leaves running. Null once the state it started in is
        // replaced, until it is reset.
        this._stopwatchFrom = 0;
        this._inDebugger = false;
        // Where the machine was as the cursor last went to the program counter.
        this._cursorPlacedAt = null;
        this._hidingPanels = false;
        this._matchedAt = 0;
        this._screenBounds = () => null;
        this._touchKeyboardShown = () => false;
        const peek = (address) => (this.cpu ? this.cpu.peekmem(address) : 0);
        this._peek = peek;
        this._credits = {
            disassembly: { line: document.querySelector("#disassembly-panel .debug-symbols"), sets: null },
            memory: { line: document.querySelector("#memory-panel .debug-symbols"), sets: null },
        };
        this.panels = Object.fromEntries(OwnPanels.map((own) => [own.id, this._makePanel(own)]));
        /** @type {Map<PagingOverride, import("../symbol-names.js").SymbolNames>} */
        this._viewNames = new Map();
        /** @type {Map<number, import("../symbol-names.js").SymbolNames>} */
        this._bankNames = new Map();
        this._paging = {
            memory: new PagingOverride({
                floating: this.panels.memory,
                changed: () => this._viewChanged(() => this._memoryView.update()),
            }),
            disassembly: new PagingOverride({
                floating: this.panels.disassembly,
                changed: () => this._viewChanged(() => this._disassembly.redraw()),
            }),
        };
        this._memoryView = new MemoryView(
            document.getElementById("memory"),
            this._paging.memory,
            () => ({ names: this._namesIn(this._paging.memory), pc: this.cpu.pc }),
            (sets) => this._credit(this._credits.memory, this._namesIn(this._paging.memory), sets),
            () => this._redraw(() => this._memoryView.update()),
        );
        this.watches = new WatchPanel({
            peek,
            resolve: (text) => this._resolveWatch(text),
            arrangement,
            searchWrites: (address) => this.whoWrote(address),
        });
        this._searching = null;
        // Fetches the index, and the sets matching memory now, so names typed while the machine runs can resolve.
        this.watches.floating.addEventListener("open", () => this._namesNow());
        this._symbolSets = symbolSets;
        this._labelFiles = labelFiles;
        this._names = NoNames;
        symbolSets?.addEventListener("loaded", () => {
            // The index arriving is what lets the sets matching memory be fetched.
            if (this.watches.floating.isOpen) this._namesNow();
            this._renameShown();
        });
        this._labelsLine = document.querySelector("#disassembly-panel .debug-labels");
        labelFiles.addEventListener("change", () => {
            this._showLabelFiles();
            this._renameShown();
        });

        this._refresh = arrangement.refreshing(
            () => this._ownPanelsShown(),
            () => this._showOpenPanels(),
        );
        arrangement.addEventListener("change", (e) => {
            if (e.detail.floating.group === DebugGroup) this._rememberOpenPanels();
        });
        this._actions = {
            go: () => this._loop.go(),
            stop: () => this._loop.stop(true),
            step: () => this._fromDebugger(() => this.step()),
            stepCycle: () => this.stepCycle(),
            stepOver: () => this._fromDebugger(() => this.stepOver()),
            stepOut: () => this._fromDebugger(() => this.stepOut()),
            stepBack: () => this._fromDebugger(() => this.stepBack(false)),
            stepBackOver: () => this._fromDebugger(() => this.stepBack(true)),
            stepBackOut: () => this._fromDebugger(() => this.stepBackSearching((history) => history.stepBackOut())),
            runToCursor: () => this._fromDebugger(() => this.runToCursor()),
            runToVsync: () => this._fromDebugger(() => this.runToVsync()),
        };
        this._disassembly = new DisassemblyView({
            floating: this.panels.disassembly,
            keys,
            paging: this._paging.disassembly,
            names: () => this._namesIn(this._paging.disassembly),
            resolve: (text) => this._resolveViewed(this._paging.disassembly, text),
            showing: (sets) => this._credit(this._credits.disassembly, this._namesIn(this._paging.disassembly), sets),
            showMemory: (address) => this._memoryView.update(address),
            offerWatch: (e, address, name) => this._offerWatch(e, address, name, this._paging.disassembly),
            runToCursor: this._actions.runToCursor,
            refit: () =>
                this._redraw(() =>
                    this._loop?.isRunning() ? this._disassembly.update(this.cpu.pc) : this._disassembly.redraw(),
                ),
        });
        this._loopNote = new TightLoopNote(this.panels.toolbar.panel.querySelector(".tight-loop"), arrangement);
        this._sheila = [];
        this.breakpoints = new BreakpointsPanel({
            arrangement,
            resolve: (text) => this._resolveBreakpoint(text),
            nameOf: (address, bank) => this._breakpointNames(bank).address(address, this.cpu.pc)?.name,
            showCode: (address, bank) => {
                this._showPinned(this._paging.disassembly, bank, address);
                this.panels.disassembly.open();
                this._disassembly.update(address);
            },
            showMemory: (address, bank) => {
                this._showPinned(this._paging.memory, bank, address);
                this.panels.memory.open();
                this._memoryView.update(address);
            },
            storage: breakpointStorage,
        });
        // So a name typed while the machine runs can resolve, and the panel names its breakpoints' addresses.
        this.breakpoints.floating.addEventListener("open", () => this._matchSymbols());
        this._bindToolbar();
        this._bindKeys(keys);
        this._bindLabelDrops();

        bindGotoForm(
            document.getElementById("goto-mem-addr-form"),
            (text) => this._resolveViewed(this._paging.memory, text),
            ({ address, view }) => {
                this._paging.memory.view = view;
                this._memoryView.update(address);
            },
        );
        bindGotoForm(
            document.getElementById("run-to-line-form"),
            (text) => (WholeNumber.test(text) ? Number(text) : undefined),
            (line) => this._fromDebugger(() => this.runToLine(line)),
        );
        document.getElementById("debug-stopwatch-reset").addEventListener("click", () => {
            if (!this.cpu) return;
            this._stopwatchFrom = this.cpu.scheduler.epoch;
            this.updateRegisters();
        });
        document.getElementById("memory").addEventListener("contextmenu", (e) => {
            const byte = e.target.closest("[data-addr]");
            if (!byte) return;
            const address = Number(byte.dataset.addr);
            const named = this._paging.memory.differs(address) ? undefined : this._names.address(address, this.cpu.pc);
            this._offerWatch(e, address, named?.name, this._paging.memory);
        });
        document.getElementById("memory").addEventListener("click", (e) => {
            if (!e.target.matches(".mem_bytes [data-addr]") || this._loop.mode !== RunMode.debugging) return;
            this._editMemory(Number(e.target.dataset.addr));
        });
        this._bindSaveForm((text) => addressFor(this._namesIn(this._paging.memory), text, this.cpu.pc));
    }

    /** Edits the byte at `address`, unless the memory panel shows there other memory than the CPU writes to. */
    _editMemory(address) {
        if (this._paging.memory.differs(address)) {
            toast(`$${hexword(address)} shows other memory than the CPU's; pick "paged" to edit it.`, {
                title: "Memory",
            });
            return;
        }
        this._memoryView.edit(
            address,
            (at, value) => this._writeByte(at, value),
            (next) => this._editMemory(next),
        );
    }

    /** Writes as the CPU would, so that a ROM byte keeps its value and a register's device sees the write. */
    _writeByte(address, value) {
        this.cpu.inputLog?.record({ kind: "write", address, value });
        this.cpu.writemem(address, value);
        const reads = this.cpu.peekmem(address);
        if (reads !== value && !this.cpu.isDevice(address)) {
            toast(`$${hexword(address)} is ROM: the write leaves it $${hexbyte(reads)}, as on the machine.`, {
                title: "Memory",
            });
        }
        this._arrangement.drawAllNow();
    }

    _bindSaveForm(resolve) {
        const form = document.getElementById("memory-save-form");
        const [from, to] = [form.elements.namedItem("from"), form.elements.namedItem("to")];
        const close = () => {
            if (form.contains(document.activeElement)) document.activeElement.blur();
            form.hidden = true;
        };
        document.getElementById("memory-save-open").addEventListener("click", () => {
            if (!form.hidden) return close();
            const shown = this._memoryView.shown();
            from.value = `$${hexword(shown.from)}`;
            to.value = `$${hexword(shown.to)}`;
            for (const field of [from, to]) field.classList.remove("is-invalid");
            form.hidden = false;
        });
        form.addEventListener("keydown", (e) => {
            if (e.key === "Escape") close();
        });
        form.addEventListener("input", (e) => e.target.classList.remove("is-invalid"));
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const [start, end] = [from, to].map((field) => resolve(field.value.trim()));
            from.classList.toggle("is-invalid", start === undefined);
            to.classList.toggle("is-invalid", end === undefined || end < start);
            if (start === undefined || end === undefined || end < start) return;
            const bytes = Uint8Array.from({ length: end - start + 1 }, (_, i) => this._paging.memory.peek(start + i));
            downloadBlob(new Blob([bytes]), `memory-${hexword(start)}-${hexword(end)}.bin`);
            close();
        });
    }

    _renameShown() {
        if (this.cpu && this.breakpoints.floating.isOpen) this._matchSymbols();
        if (!this.cpu || (!this._inDebugger && !this._ownPanelsShown())) return;
        this._matchSymbols();
        this._refresh.drawNow();
    }

    /** Lists the label files under the disassembly, each with the bank it is for and a button to forget it. */
    _showLabelFiles() {
        // Bootstrap holds on to each menu's toggle until it is disposed of, open or not.
        for (const toggle of this._labelsLine.querySelectorAll(".label-bank")) Dropdown.getInstance(toggle)?.dispose();
        const { files } = this._labelFiles;
        this._labelsLine.hidden = files.length === 0;
        this._labelsLine.replaceChildren(
            "labels from ",
            ...files.flatMap((file, i) => [...(i ? [" · "] : []), this._labelFileNode(file)]),
        );
    }

    _labelFileNode(file) {
        const node = document.createElement("span");
        node.className = "label-file dropdown";
        const bank = document.createElement("button");
        bank.type = "button";
        bank.className = "label-bank dropdown-toggle";
        bank.dataset.bsToggle = "dropdown";
        bank.textContent = file.bank === null ? "any bank" : `bank ${bankName(file.bank)}`;
        bank.title = `Which sideways bank ${file.title} names &8000 to &BFFF in`;
        // Bootstrap focuses the toggle as its menu opens.
        bank.addEventListener("hidden.bs.dropdown", () => bank.blur());
        const banks = document.createElement("div");
        banks.className = "dropdown-menu dropdown-menu-dark label-banks";
        banks.append(
            ...[null, ...Array.from({ length: NumRomBanks }, (_, n) => n)].map((choice) => {
                const item = document.createElement("button");
                item.type = "button";
                item.className = "dropdown-item";
                item.classList.toggle("active", choice === file.bank);
                item.textContent = choice === null ? "any bank" : bankName(choice);
                item.addEventListener("click", () => this._labelFiles.tie(file, choice));
                return item;
            }),
        );
        const forget = document.createElement("button");
        forget.type = "button";
        forget.className = "label-forget";
        forget.textContent = "\u00d7";
        forget.title = forget.ariaLabel = `Forget ${file.title}'s labels`;
        forget.addEventListener("click", () => this._labelFiles.remove(file));
        node.append(file.title, " ", bank, banks, forget);
        return node;
    }

    async _dropLabels(file) {
        try {
            const added = this._labelFiles.add({
                key: `dropped:${file.name}`,
                title: file.name,
                source: "",
                text: await file.text(),
                bank: null,
            });
            const names = new Set(added.labels.map(({ name }) => name)).size;
            toast(`${names} names from ${file.name} are in the debugger.`, {
                title: "Label files",
            });
        } catch (error) {
            toast(error.message, { title: "Label files" });
        }
    }

    /** The names matched to memory as `paging` shows it. */
    _namesIn(paging) {
        return paging.view === PagedView ? this._names : (this._viewNames.get(paging) ?? NoNames);
    }

    _viewChanged(redraw) {
        if (!this.cpu) return;
        this._matchSymbols();
        redraw();
    }

    /**
     * The address a Go to text names, and the view it is in: the one it qualifies the address with, or else the one
     * `paging` shows. Names resolve as matched to memory in that view.
     * @returns {{address: number, view: import("../paging.js").PagingView} | undefined}
     */
    _resolveViewed(paging, text) {
        const parsed = parseViewedAddress(text, this.cpu.model);
        if (!parsed) return undefined;
        const view = parsed.view ?? paging.view;
        const names =
            view === paging.view
                ? this._namesIn(paging)
                : this._namesFor((address) => peekViewed(this.cpu, view, address), this._bankShownBy(view));
        const address = addressFor(names, parsed.address, this.cpu.pc);
        return address === undefined ? undefined : { address, view };
    }

    /**
     * Shows sideways `bank` from its start: its code in the disassembly while stopped in the debugger, where the
     * disassembly isn't following the program counter, or else its bytes in the memory panel.
     */
    showBank(bank) {
        const [paging, floating, show] = this._inDebugger
            ? [this._paging.disassembly, this.panels.disassembly, (at) => this._disassembly.update(at)]
            : [this._paging.memory, this.panels.memory, (at) => this._memoryView.update(at)];
        paging.view = bankView(bank);
        show(SidewaysStart);
        floating.open();
    }

    // Who wrote a byte is offered only while stopped, of the memory the CPU writes to, which `paging` may not show.
    _offerWatch(e, address, name, paging) {
        e.preventDefault();
        const searchable = !this._loop.isRunning() && !paging.differs(address);
        this.watches.offer({ address, label: name ?? `$${hexword(address)}` }, e.clientX, e.clientY, searchable);
    }

    _makePanel(own) {
        const panel = document.getElementById(`${own.id}-panel`);
        if (own.naturalWidth) panel.style.setProperty("--natural-width", `${own.naturalWidth}px`);
        const floating = new FloatingPanel({
            panel,
            id: own.id,
            title: own.title,
            menuGroup: MenuGroup.cpu,
            group: DebugGroup,
            place: () => ({ ...own.place, w: this._columnWidth(own.side) }),
            minSize: own.minSize,
            arrangement: this._arrangement,
        });
        floating.addEventListener("open", () => {
            if (!this.cpu) return;
            this._matchSymbols();
            own.show(this, this._disassemblyAt());
            this._arrangement.keepAttached();
        });
        return floating;
    }

    _ownPanelsShown() {
        return OwnPanels.some(({ id }) => this.panels[id].isOpen);
    }

    /**
     * Has the panels' default places beside the screen, in the gutter on each side, when a gutter is
     * wide enough for one.
     * @param {function(): {left: number, right: number}} screenBounds - where the screen is across the window
     */
    placeBesideScreen(screenBounds) {
        this._screenBounds = screenBounds;
    }

    /**
     * Opens no panels on entering the debugger while the on-screen keyboard shows, as they would cover it; the
     * Debug menu and Alt-D still show them.
     * @param {function(): boolean} isShown
     */
    keepOffTouchKeyboard(isShown) {
        this._touchKeyboardShown = isShown;
    }

    _columnWidth(side) {
        const screen = this._screenBounds();
        if (!screen) return null;
        const room = Math.floor((side === "left" ? screen.left : window.innerWidth - screen.right) - Gap);
        return room >= ColumnWidthNeeded[side] ? room : null;
    }

    _bindToolbar() {
        const panel = this.panels.toolbar.panel;
        this._buttons = Object.fromEntries([...panel.querySelectorAll("[data-run]")].map((b) => [b.dataset.run, b]));
        for (const [run, button] of Object.entries(this._buttons)) button.addEventListener("click", this._actions[run]);
        this._stepBackTitles = Object.fromEntries(StepBackRuns.map((run) => [run, this._buttons[run].title]));
    }

    _bindKeys(keys) {
        const { toolbar, memory } = this.panels;
        keys.register({
            table: ToolbarKeys,
            actions: this._actions,
            isLive: () => this._loop.mode === RunMode.debugging,
            panel: toolbar,
        });
        keys.register({
            table: MemoryKeys,
            actions: {
                forward: () => this._memoryView.step(1),
                back: () => this._memoryView.step(-1),
                pageForward: () => this._memoryView.step(MemoryPageRows),
                pageBack: () => this._memoryView.step(-MemoryPageRows),
            },
            isLive: () => memory.isOpen,
            panel: memory,
        });
        memory.panel.querySelector(".panel-keys").textContent = keyLine(MemoryKeys);
    }

    /** Runs `act`, entering the debugger first, with the cursor where it was, if the machine is merely paused. */
    _fromDebugger(act) {
        if (this._loop.mode !== RunMode.debugging) {
            const cursor = this._disassembly.cursor;
            this._loop.stop(true);
            this._disassembly.update(cursor);
        }
        act();
    }

    /** Every panel Alt-S and Alt-D show and hide, the debugger's own first. */
    _debugPanels() {
        return this._arrangement.panelsIn(DebugGroup);
    }

    /**
     * Has every debug panel and the watch panel take a dropped label file. Other modules make debug panels,
     * before or after this, so each is marked for the media window's drop zone as a file comes over the page.
     */
    _bindLabelDrops() {
        const takers = () => [...this._debugPanels(), this.watches.floating].map(({ panel }) => panel);
        document.addEventListener(
            "dragenter",
            () => {
                for (const panel of takers()) Object.assign(panel.dataset, LabelDrop);
            },
            true,
        );
        document.addEventListener("drop", (e) => {
            const file = e.dataTransfer?.files[0];
            if (!file || !takers().some((panel) => panel.contains(e.target))) return;
            e.preventDefault();
            this._dropLabels(file);
        });
    }

    panelsShown() {
        return this._debugPanels().some((floating) => floating.isOpen);
    }

    /**
     * Opens the panels that were open when the debugger's were last seen, or the defaults if none were. The
     * toolbar always comes with them, for its buttons.
     */
    showPanels() {
        const panels = this._debugPanels();
        const remembered = rememberedPanels(panels.map(({ id }) => id));
        const chosen = remembered.length ? remembered : OwnPanels.map(({ id }) => id);
        const shown = panels.filter(({ id }) => id === "toolbar" || chosen.includes(id));
        // Filled first, so that they are laid out at the size they will be.
        if (this.cpu) {
            this._matchSymbols();
            for (const own of OwnPanels) if (shown.includes(this.panels[own.id])) own.show(this, this._disassemblyAt());
            this._refresh.drawn();
        }
        for (const floating of shown) floating.open();
    }

    /** Closes the debugger's panels, remembering which were open for the next showPanels. */
    hidePanels() {
        this._hidingPanels = true;
        for (const floating of this._debugPanels()) floating.close();
        this._hidingPanels = false;
    }

    togglePanels() {
        if (this.panelsShown()) this.hidePanels();
        else this.showPanels();
    }

    /** Enters the debugger, stopping the machine; or leaves it, closing its panels, and runs the machine on. */
    toggleDebugger() {
        if (this._loop.mode !== RunMode.debugging) return this._loop.stop(true);
        this._loop.go();
        this.hidePanels();
    }

    _rememberOpenPanels() {
        if (this._hidingPanels) return;
        rememberPanels(this._debugPanels().flatMap(({ id, isOpen }) => (isOpen ? [id] : [])));
    }

    /**
     * Has a view redraw, for a resize that changed how many rows it shows. Not through the refresh, which outside the
     * debugger draws the disassembly at the program counter rather than where it was put.
     */
    _redraw(redraw) {
        if (this.cpu) redraw();
    }

    _showOpenPanels() {
        if (!this.cpu) return;
        const now = performance.now();
        // Names are matched to what is in memory now; while it runs, not every frame, as matching peeks at it.
        if (!this._loop?.isRunning() || now - this._matchedAt >= RunningNameMatchMs) this._matchSymbols();
        for (const own of OwnPanels) if (this.panels[own.id].isOpen) own.show(this, this._disassemblyAt());
        // A state put in under a stopped machine, as the rewind scrubber does, moves it without a stop.
        if (this._inDebugger && !this._loop?.isRunning()) this._loopNote.show();
        // Not while it runs, when the names in view, and so the credit's height, can change every frame.
        if (!this._loop?.isRunning()) this._arrangement.keepAttached();
    }

    /**
     * Where the disassembly shows: the program counter while the machine runs or outside the debugger. Stopped in
     * it, the cursor, which first goes to the program counter if the processor has moved since it last went there.
     */
    _disassemblyAt() {
        if (this._loop?.isRunning() || !this._inDebugger) return this.cpu.pc;
        if (this._cursorPlacedAt !== cpuMoment(this.cpu)) {
            this._disassembly.update(this.cpu.pc);
            this._noteCursorAtPc();
        }
        return this._disassembly.cursor;
    }

    _noteCursorAtPc() {
        this._cursorPlacedAt = cpuMoment(this.cpu);
    }

    /**
     * Shows the disassembly around `address`, centred on it, unless the machine is stopped and it is the instruction
     * already highlighted, which stays in its row.
     */
    updateDisassembly(address) {
        this._paging.disassembly.relabel();
        if (address === this._disassembly.cursor && !this._loop?.isRunning()) this._disassembly.redraw();
        else this._disassembly.update(address);
    }

    updateMemory() {
        this._paging.memory.relabel();
        this._memoryView.update();
    }

    setCpu(cpu) {
        this.cpu = cpu;
        for (const paging of Object.values(this._paging)) paging.setCpu(cpu);
        this._disassembly.setCpu(cpu);
        this._loopNote.setCpu(cpu);
        this.watches.setCpu(cpu);
        cpu.breakpoints.onHit((hit) => {
            if (hit.action === "log") console.log(describeHit(hit));
        });
        this._sheila = machineSheilaBlocks(cpu);
        this.breakpoints.setCpu(cpu);
        if (this._ownPanelsShown()) this._refresh.drawNow();
    }
    updateElem(elem, val) {
        const prevVal = elem.textContent;
        if (prevVal !== val) {
            elem.textContent = val;
        }
        elem.classList.toggle("changed", prevVal !== val && prevVal !== "");
    }

    updateRegisters() {
        const cpu = this.cpu;
        const top = (cpu.s + 1) & 0xff;
        const stack = [];
        for (let at = top; at <= 0xff && at > cpu.s && stack.length < StackBytesShown; at++)
            stack.push(hexbyte(cpu.peekmem(0x100 + at)));
        this.updateElem(document.getElementById("cpu6502_stack"), stack.join(" "));
        this.updateElem(document.getElementById("cpu6502_cycles"), String(cycleCount(cpu)));
        const stopwatch = this._stopwatchFrom === null ? "" : String(cpu.scheduler.epoch - this._stopwatchFrom);
        this.updateElem(document.getElementById("debug-stopwatch"), stopwatch);
        const beam = cpu.video.beamPosition();
        this.updateElem(document.getElementById("beam-line"), String(beam.line));
        this.updateElem(document.getElementById("beam-cycle"), String(beam.frameCycle));
        document.getElementById("beam-crtc").hidden = !beam.crtc;
        if (beam.crtc) {
            this.updateElem(document.getElementById("crtc-row"), String(beam.crtc.row));
            this.updateElem(document.getElementById("crtc-scanline"), String(beam.crtc.scanline));
            this.updateElem(document.getElementById("crtc-column"), String(beam.crtc.column));
        }
        this.updateElem(document.getElementById("cpu6502_a"), hexbyte(this.cpu.a));
        this.updateElem(document.getElementById("cpu6502_x"), hexbyte(this.cpu.x));
        this.updateElem(document.getElementById("cpu6502_y"), hexbyte(this.cpu.y));
        this.updateElem(document.getElementById("cpu6502_s"), hexbyte(this.cpu.s));
        this.updateElem(document.getElementById("cpu6502_pc"), hexword(this.cpu.pc));
        for (const flag of ["c", "z", "i", "d", "v", "n"]) {
            this.updateElem(
                document.getElementById("cpu6502_flag_" + flag),
                this.cpu.p[flag] ? flag.toUpperCase() : flag,
            );
        }
    }

    execPatch(instString) {
        this.cpu.inputLog?.refuse("a patch from the URL");
        for (const inst of instString.split(",")) {
            if (!inst) continue;
            const ops = inst.split(":");
            let addr = parseInt(ops[0], 16);
            const setTo = ops[1];
            for (let i = 0; i < setTo.length; i += 2) {
                const b = parseInt(setTo.substring(i, i + 2), 16);
                this.cpu.writemem(addr, b);
                addr++;
            }
        }
    }

    setPatch(patch) {
        for (const inst of patch.split(";")) {
            if (inst[0] === "@") {
                const at = parseInt(inst.substring(1, 5), 16);
                if (!this.patchInstructions.has(at)) this.patchInstructions.set(at, []);
                this.patchInstructions.get(at).push(inst.substring(5));
            } else {
                this.execPatch(inst);
            }
        }
        if (this.patchInstructions.size > 0) {
            const hook = this.cpu.debugInstruction.add((pc) => {
                if (!this.patchInstructions.has(pc)) return false;
                for (const inst of this.patchInstructions.get(pc)) this.execPatch(inst);
                this.patchInstructions.delete(pc);
                if (this.patchInstructions.size === 0) {
                    console.log("All patches done");
                    hook.remove();
                }
                return false;
            });
        }
    }

    debug(where) {
        this.cancelRun();
        this._matchSymbols();
        for (const own of OwnPanels) own.show(this, where);
        this._noteCursorAtPc();
        this._loopNote.show();
        this.watches.showWhichFired();
        this._refresh.drawn();
        if (!this._inDebugger) {
            noteFeature("debugger", "open");
            this._inDebugger = true;
            this._monitor.classList.add("finds-bytes");
            if (!this._touchKeyboardShown()) this.showPanels();
        }
        this._arrangement.keepAttached();
        this._showStepBack();
        this.cpu.video.debugPaint();
    }

    /**
     * The names for a breakpoint pinned to sideways `bank`, matched to that bank, or for any other as paged; matched
     * again as often as the debugger's own panels match theirs while the machine runs, so the Breakpoints panel,
     * refreshed each frame, keeps up with memory when it is the only panel open.
     */
    _breakpointNames(bank) {
        if (performance.now() - this._matchedAt >= RunningNameMatchMs) this._matchSymbols();
        const view = this._bankViewOf(bank);
        if (view === undefined) return this._names;
        if (!this._bankNames.has(bank)) {
            this._bankNames.set(
                bank,
                this._namesFor((address) => peekViewed(this.cpu, view, address), bank),
            );
        }
        return this._bankNames.get(bank);
    }

    /** The view of sideways `bank`, if there is one: none for no bank, nor on a machine without the view (the Atom). */
    _bankViewOf(bank) {
        if (bank === undefined) return undefined;
        const view = bankView(bank);
        return viewsFor(this.cpu.model).includes(view) ? view : undefined;
    }

    /** Sets `paging` to show sideways `bank`, a breakpoint's at `address`, where the view can show it there. */
    _showPinned(paging, bank, address) {
        const view = this._bankViewOf(bank);
        if (view !== undefined && address >= SidewaysStart && address < SidewaysEnd) paging.view = view;
    }

    _matchSymbols() {
        this._names = this._namesNow();
        this._viewNames = new Map(
            Object.values(this._paging)
                .filter((paging) => paging.view !== PagedView)
                .map((paging) => [
                    paging,
                    this._namesFor((address) => paging.peek(address), this._bankShownBy(paging.view)),
                ]),
        );
        this._bankNames = new Map();
        this._matchedAt = performance.now();
        this.breakpoints.update();
    }

    /** Credits the sets whose names a panel shows, in its own line. */
    _credit(credit, names, sets) {
        const credited = names.sets.filter((set) => sets.has(set));
        if (credit.sets?.size === credited.length && credited.every((set) => credit.sets.has(set))) return;
        credit.sets = new Set(credited);
        credit.line.style.visibility = credited.length > 0 ? "" : "hidden";
        credit.line.replaceChildren(
            "names from ",
            ...credited.flatMap((set, i) => {
                const title = document.createElement("span");
                title.className = "symbol-set";
                title.textContent = set.title;
                title.title = [set.licence, set.notice].filter(Boolean).join("\n\n");
                const origin = set.source ? [" (", ...homeNodes(set.home), sourceNode(set.source), ")"] : [];
                return [...(i ? [" · "] : []), title, ...origin];
            }),
        );
        credit.line.title = credit.line.textContent;
    }

    _namesNow() {
        return this._namesFor(this._peek, this.cpu?.pagedBank);
    }

    /** The sideways bank whose labels apply in `view`: the bank it shows, or else the one paged. */
    _bankShownBy(view) {
        return viewedBank(view) ?? this.cpu?.pagedBank;
    }

    /** The names for memory as `peek` reads it, with sideways `bank` at &8000, as a label file sees it. */
    _namesFor(peek, bank) {
        return this._labelFiles.names(this._symbolSets?.names(peek) ?? NoNames, bank);
    }

    _resolveWatch(text) {
        const names = this._namesNow();
        const pc = this.cpu?.pc;
        const address = addressFor(names, text, pc);
        if (address === undefined) return undefined;
        const label = parseAddr(text) === address ? names.address(address, pc)?.name : text;
        return { address, label: label ?? `$${hexword(address)}` };
    }

    /**
     * What a breakpoint's address `text` names, as a watch's does or as a SHEILA register such as SysVIA.ORB, and
     * the name if it was one rather than a number.
     */
    _resolveBreakpoint(text) {
        const address = this._resolveWatch(text)?.address ?? sheilaAddress(this._sheila, text);
        if (address === undefined) return undefined;
        return { address, name: parseAddr(text) === undefined ? text : undefined };
    }

    /** Whether the machine is stopped in the debugger. */
    inDebugger() {
        return this._inDebugger;
    }

    /**
     * While the machine is stopped in the debugger, opens the memory panel at the byte drawn at a point of the
     * screen, 0 to 1 across and down it, in the RAM it is drawn from, and takes the click; otherwise, or while the
     * on-screen keyboard shows, the click is the machine's.
     */
    showScreenByteAt(x, y) {
        if (!this._inDebugger || this._touchKeyboardShown()) return false;
        const address = this.cpu.video.addressShownAt(x, y);
        if (address !== null) {
            this._paging.memory.view = screenView(this.cpu, address);
            this._memoryView.update(address);
            this.panels.memory.open();
        }
        return true;
    }

    updatePrevMem() {
        this._memoryView.snapshot();
    }

    /** Leaves the debugger as the machine runs or pauses, leaving its panels open. */
    hide() {
        // Only running carries a run on; a pause or a frame step ends it, as entering the debugger does.
        if (this._loop?.mode !== RunMode.running) this.cancelRun();
        if (!this._inDebugger) return;
        // A run handed to the loop keeps the memory it started from, to show what it changed.
        if (!this._runningTo) this.updatePrevMem();
        this.watches.dismissMenu();
        for (const paging of Object.values(this._paging)) paging.dismissMenu();
        this.watches.clearFired();
        this._inDebugger = false;
        this._loopNote.clear();
        this._arrangement.keepAttached();
        this._monitor.classList.remove("finds-bytes");
        // Focus left in a goto box would keep the keyboard from the machine.
        const focused = document.activeElement;
        if (this._debugPanels().some((floating) => floating.panel.contains(focused))) focused.blur();
    }

    /** The loop that runs the machine for the steps that need running. */
    attachLoop(loop) {
        this._loop = loop;
        loop.addEventListener("running", () => this._showRunning());
        this._showRunning();
    }

    /** What the machine steps back through; until there is one, there is nothing to step back to. */
    attachStepBack(history) {
        this._history = history;
    }

    _showRunning() {
        const running = this._loop.isRunning();
        for (const [run, button] of Object.entries(this._buttons)) button.disabled = running !== (run === "stop");
        if (!running) this._showStepBack();
    }

    _stepBackRefusal() {
        if (this._loop.lockstep) return NoStepBackInSession;
        return this._history ? this._history.refusal() : NoHistory;
    }

    // Left able to be pressed, so that its tooltip and a press say why it cannot step back.
    _showStepBack() {
        const refusal = this._stepBackRefusal();
        for (const run of StepBackRuns) {
            const button = this._buttons[run];
            button.setAttribute("aria-disabled", String(refusal !== null));
            button.title = refusal ?? this._stepBackTitles[run];
        }
    }

    /** Runs one instruction, stepping off a breakpoint on it; false when a watch stopped the machine in it. */
    executeOne() {
        const cpu = this.cpu;
        // TODO(#1062) this drops the residual cycles.
        cpu.targetCycles = cpu.currentCycles;
        if (cpu.execute(1)) return true;
        if (!cpu.debugInstruction.stopped) return false;
        cpu.targetCycles = cpu.currentCycles;
        return cpu.execute(1);
    }

    resetEntry() {
        return this.cpu.peekmem(ResetVector) | (this.cpu.peekmem(ResetVector + 1) << 8);
    }

    /**
     * Runs the machine until `stopsHere()`, asked before each instruction after the first, says to stop at it, or
     * anything else stops the machine. The first instruction always runs, so a run can come round to where it
     * starts. A reset ends the run without stopping, unless `stopsAtReset` and `stopsHere()` holds at the entry.
     * A run that ends within a fiftieth of a second ends here, so the debugger never leaves the screen; a longer
     * one goes on in the loop, with the machine shown running, and lasts through holds such as a dialog or a
     * hidden tab.
     */
    runTo(stopsHere, stopsAtReset) {
        this.updatePrevMem();
        const cpu = this.cpu;
        if (!this.executeOne()) return this.debug(cpu.pc);
        const resetEntry = this.resetEntry();
        this._runningTo = cpu.debugInstruction.add((pc) => {
            if (pc !== resetEntry) return stopsHere();
            if (stopsAtReset && stopsHere()) return true;
            this.cancelRun();
            return false;
        });
        // In a shared session the rest of the run goes through the loop's lockstep; only the first instruction
        // stepped above runs outside it, as `n` does.
        if (this._loop.lockstep) return this._loop.go();
        cpu.targetCycles = cpu.currentCycles;
        let ranOn;
        try {
            ranOn = cpu.execute(this._loop.clocksPerSecond / QuickRunsPerSecond);
        } catch (e) {
            this.debug(cpu.pc);
            throw e;
        }
        if (!ranOn) return this.debug(cpu.pc);
        this._loop.go();
    }

    /** Forgets a run to a stop, as when the machine's state is replaced under it. */
    cancelRun() {
        this._runningTo?.remove();
        this._runningTo = null;
    }

    /** The machine's state is being replaced, so neither a run to a stop nor the stopwatch's start applies. */
    replacingState() {
        this.cancelRun();
        this._stopwatchFrom = null;
    }

    /**
     * Moves the CPU's cycle target on by one, running each instruction that starts before it. Straight after a
     * breakpoint the target is still at the end of the interrupted time slice, so this runs on to there (#1062).
     */
    stepCycle() {
        this.updatePrevMem();
        this.cpu.execute(1);
        this.debug(this.cpu.pc);
    }

    step() {
        this.updatePrevMem();
        this.executeOne();
        this.debug(this.cpu.pc);
    }

    /** Steps back one instruction, or with `over` back over the call just returned from; see ReplayHistory. */
    stepBack(over) {
        this._stepBackBy(() => this._history.stepBack(over));
    }

    /** Steps back to `cycle`, as `whoWrote` finds one; see ReplayHistory. */
    stepBackTo(cycle) {
        this._stepBackBy(() => this._history.stepBackTo(cycle));
    }

    _stepBackBy(goBack) {
        const refusal = this._stepBackRefusal() ?? this._steppedBack(goBack);
        if (refusal) toast(refusal, { title: "Step back" });
        this.debug(this.cpu.pc);
    }

    /**
     * Steps back as `search(history)`, one of the ReplayHistory's steps back a stretch at a time, does, letting the
     * page go on between stretches; a later search ends one still going. Resolves once it has landed, said why it
     * could not, or been ended.
     */
    async stepBackSearching(search) {
        const refusal = this._stepBackRefusal();
        if (refusal) {
            toast(refusal, { title: "Step back" });
            return;
        }
        this.updatePrevMem();
        const steppedBack = await this._runSearch(
            search(this._history),
            "Searching back.",
            "Step back",
            () => this._loop.mode === RunMode.debugging,
        );
        if (steppedBack === Ended) return;
        if (this._stopwatchFrom > this.cpu.scheduler.epoch) this._stopwatchFrom = null;
        if (steppedBack) toast(steppedBack, { title: "Step back" });
        // A search the machine moved on from, as by a run, leaves it to whatever moved it.
        if (this._loop.mode === RunMode.debugging) this.debug(this.cpu.pc);
    }

    /**
     * Runs `searching`, a search back through the history, a stretch at a time, saying `searchingText` under `title`
     * while it takes more than one, as long as `wanted()` holds between stretches. Resolves to what it returns, or
     * Ended if a later search ended it or it was no longer wanted.
     */
    async _runSearch(searching, searchingText, title, wanted) {
        this._searching = searching;
        let step = searching.next();
        const notice = step.done ? null : toast(searchingText, { title });
        try {
            while (!step.done) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (this._searching !== searching || !wanted()) return Ended;
                step = searching.next();
            }
        } finally {
            if (notice) dismissToast(notice);
        }
        this._searching = null;
        return step.value;
    }

    _steppedBack(goBack) {
        this.updatePrevMem();
        const refusal = goBack();
        // Gone back past where the stopwatch was started, it has nothing to time from.
        if (this._stopwatchFrom > this.cpu.scheduler.epoch) this._stopwatchFrom = null;
        return refusal;
    }

    /**
     * Finds what last wrote the byte at `address`, as the CPU pages it now, by searching back through the history
     * step back keeps (see ReplayHistory's lastWrite), and says so, offering to step back to the instruction while
     * the machine is where the search left it. It stops the machine in the debugger first. The search lets the page
     * go on between stretches of the history; a later search ends one still going. Resolves to what lastWrite
     * returns, or null if a later search ended it.
     */
    async whoWrote(address) {
        if (this._loop.mode !== RunMode.debugging) this._loop.stop(true);
        const where = `$${hexword(address)}`;
        const title = `Who wrote ${where}`;
        const unavailable = this._loop.lockstep ? NoSearchInSession : this._history ? null : NoHistoryToSearch;
        if (unavailable) {
            toast(unavailable, { title });
            return { refusal: unavailable };
        }
        const found = await this._runSearch(
            this._history.lastWrite(address),
            `Searching back for the last write to ${where}.`,
            title,
            () => true,
        );
        if (found === Ended) return null;
        const { write } = found;
        const action =
            write && write.pc !== null ? { label: "Step back to it", run: this._stepBackToWrite(write) } : null;
        toast(this._lastWriteText(where, found), { title, action });
        return found;
    }

    // A cycle found is only that write's while the machine is where the search found it from.
    _stepBackToWrite({ cycle }) {
        const [searchedAt, searchedHash] = [cycleCount(this.cpu), stateHash(this.cpu)];
        return () => {
            const moved = cycleCount(this.cpu) !== searchedAt || stateHash(this.cpu) !== searchedHash;
            if (moved) toast(MovedSinceSearch, { title: "Step back" });
            else this._fromDebugger(() => this.stepBackTo(cycle));
        };
    }

    _lastWriteText(where, { refusal, write, searched, stoppedBy }) {
        if (refusal) return refusal;
        const cpu = this.cpu;
        const ago = (cycles) => `${cycles} cycles (${durationText(cycles / cpu.model.cyclesPerSecond)})`;
        if (!write) {
            const why = stoppedBy
                ? `; the search cannot go back past ${stoppedBy}`
                : ", as far back as the history step back keeps goes";
            return `Nothing wrote ${where} in the last ${ago(searched)}${why}.`;
        }
        const { pc, cycle, value } = write;
        const name = pc === null ? undefined : this._names.address(pc, cpu.pc)?.name;
        const by =
            pc === null
                ? "an edit in the memory panel"
                : `the instruction at $${hexword(pc)}${name ? ` (${name})` : ""}`;
        const when = `at cycle ${cycle}, ${ago(cycleCount(cpu) - cycle)} ago`;
        return `${where} was last written $${hexbyte(value)} by ${by}, ${when}.`;
    }

    stepOver() {
        const { pc, s } = this.cpu;
        const { flow, next: end, target } = this.cpu.disassembler.instructionAt(pc);
        const next = end & 0xffff;
        const entry = this.resetEntry();
        if (NeverFallsThrough.has(flow)) return this.step();
        if (flow === "branch" && target <= pc) {
            return this.runTo(() => notDeeper(this.cpu.s, s) && (this.cpu.pc < target || this.cpu.pc > pc), false);
        }
        if (flow === "branch") {
            return this.runTo(() => this.cpu.pc === next || this.cpu.pc === target, next === entry || target === entry);
        }
        if (flow === "call") return this.runTo(() => this.cpu.pc === next && notDeeper(this.cpu.s, s), next === entry);
        this.runTo(() => this.cpu.pc === next, next === entry);
    }

    stepOut() {
        const { cpu } = this;
        const s = cpu.s;
        const returnsHere = () => cpu.disassembler.describeOpcode(cpu.peekmem(cpu.pc)).flow === "return";
        let returning = returnsHere();
        this.runTo(() => {
            if (returning) return true;
            returning = notDeeper(cpu.s, s) && returnsHere();
            return false;
        }, false);
    }

    /** Runs the machine, from the debugger, until `stopsHere()` holds before an instruction; see runTo. */
    runUntil(stopsHere) {
        this._fromDebugger(() => this.runTo(stopsHere, false));
    }

    runToCursor() {
        const target = this._disassembly.cursor;
        this.runTo(() => this.cpu.pc === target, target === this.resetEntry());
    }

    /** Runs until `holds()` turns true: at an instruction it holds at, having not held at the one before. */
    _runUntilTurns(holds) {
        let held = holds();
        this.runTo(() => {
            const had = held;
            held = holds();
            return held && !had;
        }, false);
    }

    runToVsync() {
        this._runUntilTurns(() => this.cpu.video.beamPosition().inVSync);
    }

    /** Runs to the start of TV line `line` of a frame, the next frame's if the beam is on it now. */
    runToLine(line) {
        this._runUntilTurns(() => this.cpu.video.beamPosition().line === line);
    }
}
