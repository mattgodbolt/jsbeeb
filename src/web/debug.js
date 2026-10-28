import { toggle } from "./dom-utils.js";
import { hexbyte, hexword, parseAddr } from "../hex.js";
import { NoNames } from "../symbol-names.js";
import { isHttps, nameUrl } from "../symbol-sets.js";
import { sheilaBlocks, sheilaName } from "../sheila.js";
import { noteFeature } from "./analytics.js";
import { SysViaPanel } from "./sysvia-panel.js";
import { WatchPanel } from "./watch-panel.js";
import { RunMode } from "./emulation-loop.js";

const noop = () => {};

const numToShow = 16;
const QuickRunsPerSecond = 50;
const ResetVector = 0xfffc;
const UnconditionalJump = /^(JMP|RTS|RTI|BRK)\b/;
const Branch = /^(B(CC|CS|EQ|NE|MI|PL|VC|VS|RA)|BB[RS][0-7])\b/;
const Call = /^JSR\b/;
const ReturnOpcodes = new Set([0x60, 0x40]); // RTS, RTI

const Writes = /^\*?(?:ST[AXYZ]|SAX|SH[ASXY])\b/;
const ReadModifyWrites = /^\*?(?:ASL|LSR|ROL|ROR|INC|DEC|TSB|TRB|DCP|ISB|RLA|RRA|SLO|SRE)\b/;

/** @returns {("read" | "write")[]} */
function operandAccesses(instruction) {
    if (Writes.test(instruction)) return ["write"];
    if (ReadModifyWrites.test(instruction)) return ["read", "write"];
    return ["read"];
}

// S counts down and wraps, so "not deeper" is a difference of under half the page, either way round $00.
function notDeeper(s, startS) {
    return ((s - startS) & 0xff) < 0x80;
}

function labelHtml(addr) {
    return '<span class="addr">' + hexword(addr) + "</span>";
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
    const node = url ? externalLink(url) : document.createElement("span");
    node.classList.add("symbol");
    showName(node, named, addr);
    return node;
}

function externalLink(url, text = "") {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = text;
    // A focused link would keep the debugger's keys from reaching it, so no button may focus it.
    link.addEventListener("mousedown", (e) => e.preventDefault());
    return link;
}

function sourceNode(source) {
    return isHttps(source) ? externalLink(source, "source") : document.createTextNode(source);
}

function homeNodes(home) {
    if (!isHttps(home)) return [];
    return [externalLink(home, new URL(home).hostname.replace(/^www\./, "")), ", "];
}

// Clone a template row, unhide it, append to parent, and remove the template class.
function cloneTemplate(container) {
    const template = container.querySelector(".template");
    const clone = template.cloneNode(true);
    clone.classList.remove("template");
    clone.style.display = "";
    container.appendChild(clone);
    return clone;
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
     * @param {(address: number) => number} peekMem
     * @param {() => {names: import("../symbol-names.js").SymbolNames, pc: number}} naming
     * @param {(sets: Set<import("../symbol-names.js").SymbolSet>) => void} showing - the sets whose names it shows
     */
    constructor(widget, peekMem, naming, showing) {
        this._widget = widget;
        this._peekMem = peekMem;
        this._naming = naming;
        this._showing = showing;
        this._addr = 0;
        this._prevSnapshot = new Uint8Array(65536);
        this._rows = [];

        for (let i = 0; i < numToShow; i++) {
            this._rows.push(cloneTemplate(this._widget));
        }
        this._widget.querySelector(".template").remove();

        widget.addEventListener("wheel", (evt) => {
            const deltaY = evt.deltaY;
            if (deltaY === 0) return;
            const steps = (deltaY / 20) | 0;
            this.update(this._addr + 8 * steps);
            evt.preventDefault();
        });
    }

    update(maybeNewAddr) {
        if (maybeNewAddr !== undefined) this._addr = maybeNewAddr;
        let addr = this._addr - 8 * Math.floor(this._rows.length / 2);
        if (addr < 0) addr = 0;
        const { names, pc } = this._naming();
        const shown = new Set();
        for (const row of this._rows) {
            row.querySelector(".dis_addr").innerHTML = labelHtml(addr);
            row.classList.toggle("highlight", addr === this._addr);
            const dump = this.dump(addr, addr + 8);
            const bytes = row.querySelectorAll(".mem_bytes span");
            const ascii = row.querySelectorAll(".mem_asc span");
            for (let i = 0; i < 8; ++i) {
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
                    span.classList.toggle("region", !!inRegion);
                    span.classList.toggle("region-start", inRegion?.region.start === address);
                    span.title = inRegion || named ? memoryTitle(address, named, inRegion) : "";
                }
            }
            addr = (addr + 8) & 0xffff;
        }
        this._showing(shown);
    }

    // TODO(#1062) extract memory part from view part and reuse in disassembler etc. also peekmem can go then
    dump(from, to) {
        const hex = [];
        const asc = [];
        const changed = [];
        for (let i = from; i < to; ++i) {
            const b = this._peekMem(i);
            hex.push(hexbyte(b));
            changed.push(i < this._prevSnapshot.length && this._prevSnapshot[i] !== b);
            if (b >= 32 && b < 128) {
                asc.push(String.fromCharCode(b));
            } else {
                asc.push(".");
            }
        }
        return { hex: hex, asc: asc, changed: changed };
    }

    snapshot() {
        for (let i = 0; i < 65536; ++i) {
            this._prevSnapshot[i] = this._peekMem(i);
        }
    }

    step(delta) {
        this.update(this._addr + delta);
    }
}

export class Debugger {
    /**
     * @param {object} [options]
     * @param {import("../symbol-sets.js").SymbolSets} [options.symbolSets] - where names for addresses come from
     */
    constructor({ symbolSets = null } = {}) {
        this.patchInstructions = new Map();
        this._loop = null;
        this._runningTo = null;
        this._enabled = false;
        this.disass = document.getElementById("disassembly");
        const peek = (address) => (this.cpu ? this.cpu.peekmem(address) : 0);
        this._peek = peek;
        this._memoryView = new MemoryView(
            document.getElementById("memory"),
            peek,
            () => ({ names: this._names, pc: this.cpu.pc }),
            (sets) => {
                this._memorySets = sets;
                this._credit();
            },
        );
        this.watches = new WatchPanel({ peek, resolve: (text) => this._resolveWatch(text) });
        // The Atom's CPU carries a system VIA it never wires up.
        this.sysViaPanel = new SysViaPanel({ via: () => (this.cpu?.model.isAtom ? undefined : this.cpu?.sysvia) });
        // Fetches the index, and the sets matching memory now, so names typed while the machine runs can resolve.
        this.watches.floating.addEventListener("open", () => this._namesNow());
        this.debugNodes = document.querySelectorAll("#debug, #hardware_debug, #crtc_debug");
        this.disassPc = 0;
        this.disassStack = [];
        this.uservia = this.sysvia = this.crtc = null;
        this._sheila = [];
        this.breakpoints = {};
        this._symbolSets = symbolSets;
        this._names = NoNames;
        this._symbolsLine = document.getElementById("debug-symbols");
        this._credited = null;
        this._disassemblySets = new Set();
        this._memorySets = new Set();
        toggle(this._symbolsLine, symbolSets !== null);
        symbolSets?.addEventListener("loaded", () => {
            // The index arriving is what lets the sets matching memory be fetched.
            if (this.watches.floating.isOpen) this._namesNow();
            if (!this._enabled) return;
            this._matchSymbols();
            this.updateDisassembly(this.disassPc);
            this._memoryView.update();
        });

        const setupGoto = (form, func) => {
            const addr = form.querySelector(".goto-addr");
            addr.addEventListener("input", () => addr.classList.remove("is-invalid"));
            form.addEventListener("submit", (e) => {
                e.preventDefault();
                const text = addr.value.trim();
                if (!text) return;
                const address = addressFor(this._names, text, this.cpu.pc);
                addr.classList.toggle("is-invalid", address === undefined);
                if (address === undefined) return;
                func(address);
                addr.value = "";
                addr.blur();
            });
        };

        setupGoto(document.getElementById("goto-mem-addr-form"), (address) => this._memoryView.update(address));
        setupGoto(document.getElementById("goto-dis-addr-form"), this.updateDisassembly.bind(this));

        this.enable(false);

        for (let i = 0; i < numToShow; i++) {
            cloneTemplate(this.disass);
        }

        this.disass.addEventListener("click", (e) => {
            if (e.target.closest(".bp_gutter")) this.bpClick(e);
        });

        const offerWatch = (e, address, name) => {
            e.preventDefault();
            this.watches.offer({ address, label: name ?? `$${hexword(address)}` }, e.clientX, e.clientY);
        };
        document.getElementById("memory").addEventListener("contextmenu", (e) => {
            const byte = e.target.closest("[data-addr]");
            if (!byte) return;
            const address = Number(byte.dataset.addr);
            offerWatch(e, address, this._names.address(address, this.cpu.pc)?.name);
        });
        this.disass.addEventListener("contextmenu", (e) => {
            const at = Number(e.target.closest(".dis_elem")?.dataset.addr);
            const operand = e.target.closest(".instr_mem_ref, .instr_instr_ref");
            if (operand) {
                offerWatch(e, Number(operand.dataset.ref), operand.dataset.name);
            } else if (e.target.closest(".dis_addr")) {
                offerWatch(e, at, this._names.address(at, this.cpu.pc)?.name);
            }
        });

        this.disass.addEventListener("wheel", (evt) => {
            let deltaY = evt.deltaY;
            if (deltaY === 0) return;
            let addr = this.disassPc;
            const func = deltaY < 0 ? this.prevInstruction.bind(this) : this.nextInstruction.bind(this);
            deltaY = Math.abs(deltaY);
            while (deltaY > 0) {
                addr = func(addr);
                deltaY -= 30;
            }
            this.updateDisassembly(addr);
            evt.preventDefault();
        });
    }

    setCpu(cpu) {
        this.cpu = cpu;
        this.sysvia = this.setupVia(document.getElementById("sysvia"), cpu.sysvia);
        this.uservia = this.setupVia(document.getElementById("uservia"), cpu.uservia);
        this.crtc = this.setupCrtc(document.getElementById("crtc_debug"), cpu.video);
        this._sheila = sheilaBlocks({
            model: cpu.model,
            hasTube: cpu.hasTube,
            hasEconet: !!cpu.econet,
            hasVideoNula: cpu.video.ula.hasVideoNula,
        });
    }

    disassemble(addr) {
        return this.cpu.disassembler.disassemble(addr);
    }

    setupCrtc(node, video) {
        if (!video) return noop;
        const updates = [];
        for (const row of node.querySelectorAll("tr:not(.template)")) row.remove();

        const regNode = node.querySelector(".crtc_regs");

        function makeRow(container, text) {
            const row = cloneTemplate(container);
            row.querySelector(".register").textContent = text;
            return row.querySelector(".value");
        }

        for (let i = 0; i < 16; ++i) {
            const value = makeRow(regNode, "R" + i);
            updates.push(() => {
                this.updateElem(value, hexbyte(video.regs[i]));
            });
        }

        const stateNode = node.querySelector(".crtc_state");
        const others = [
            "bitmapX",
            "bitmapY",
            "dispEnabled",
            "horizCounter",
            "inHSync",
            "scanlineCounter",
            "vertAdjustCounter",
            "vertCounter",
            "inVSync",
            "endOfMainLatched",
            "endOfVertAdjustLatched",
            "inVertAdjust",
            "inDummyRaster",
            "addr",
            "lineStartAddr",
            "nextLineStartAddr",
        ];
        for (const elem of others) {
            const value = makeRow(stateNode, elem);
            if (typeof video[elem] === "boolean") {
                updates.push(() => this.updateElem(value, video[elem] ? "true" : "false"));
            } else {
                updates.push(() => this.updateElem(value, hexword(video[elem])));
            }
        }

        const update = () => {
            for (const update of updates) update();
        };
        update();
        return update;
    }

    setupVia(node, via) {
        const updates = [];
        if (!via) return noop;
        const regs = [
            "ora",
            "orb",
            "ira",
            "irb",
            "ddra",
            "ddrb",
            "acr",
            "pcr",
            "ifr",
            "ier",
            "t1c",
            "t1l",
            "t2c",
            "t2l",
            "t2High",
            "portapins",
            "portbpins",
            "IC32",
        ];
        for (const row of node.querySelectorAll("tr:not(.template)")) row.remove();
        let timers;
        for (const elem of regs) {
            if (via[elem] === undefined) continue;
            const row = cloneTemplate(node);
            row.querySelector(".register").textContent = elem.toUpperCase();
            const value = row.querySelector(".value");
            if (elem.match(/t[12][cl]/)) {
                updates.push(() => this.updateElem(value, hexword(timers[elem])));
            } else {
                updates.push(() => {
                    this.updateElem(value, hexbyte(via[elem]));
                });
            }
        }
        const update = () => {
            timers = via.peekTimers();
            for (const update of updates) update();
        };
        update();
        return update;
    }

    updateElem(elem, val) {
        const prevVal = elem.textContent;
        if (prevVal !== val) {
            elem.textContent = val;
        }
        elem.classList.toggle("changed", prevVal !== val && prevVal !== "");
    }

    updateRegisters() {
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
        this.enable(true);
        this._matchSymbols();
        this.updateDisassembly(where);
        this.updateRegisters();
        this._memoryView.update();
        this.sysvia();
        this.uservia();
        this.crtc();
        this.cpu.video.debugPaint();
    }

    _matchSymbols() {
        this._names = this._namesNow();
    }

    _credit() {
        const sets = this._names.sets.filter((set) => this._disassemblySets.has(set) || this._memorySets.has(set));
        if (this._credited?.length === sets.length && sets.every((set, i) => set === this._credited[i])) return;
        this._credited = sets;
        this._symbolsLine.style.visibility = sets.length > 0 ? "" : "hidden";
        this._symbolsLine.replaceChildren(
            "names from ",
            ...sets.flatMap((set, i) => {
                const title = document.createElement("span");
                title.className = "symbol-set";
                title.textContent = set.title;
                title.title = [set.licence, set.notice].filter(Boolean).join("\n\n");
                return [...(i ? [" · "] : []), title, " (", ...homeNodes(set.home), sourceNode(set.source), ")"];
            }),
        );
    }

    enable(e) {
        // A run handed to the loop keeps the memory it started from, to show what it changed.
        if (this._enabled && !e && !this._runningTo) {
            this.updatePrevMem();
        }
        if (e && !this._enabled) noteFeature(document.getElementById("debug"), "open");
        if (this._enabled && !e) this.watches.dismissMenu();
        this._enabled = e;
        const focused = document.activeElement;
        if (!e && [...this.debugNodes].some((node) => node.contains(focused))) focused.blur();
        for (const node of this.debugNodes) toggle(node, this._enabled);
    }

    _namesNow() {
        return this._symbolSets?.names(this._peek) ?? NoNames;
    }

    _resolveWatch(text) {
        const names = this._namesNow();
        const pc = this.cpu?.pc;
        const address = addressFor(names, text, pc);
        if (address === undefined) return undefined;
        const label = parseAddr(text) === address ? names.address(address, pc)?.name : text;
        return { address, label: label ?? `$${hexword(address)}` };
    }

    enabled() {
        return this._enabled;
    }

    updateDisassembly(address) {
        this.disassPc = address;
        const elems = Array.from(this.disass.children).filter(
            (el) => el.style.display !== "none" && !el.classList.contains("template"),
        );
        const shown = new Set();

        const updateDisElem = (elem, address) => {
            const result = this.disassemble(address);
            const dump = this._memoryView.dump(address, result[1]);
            const addrNode = elem.querySelector(".dis_addr");
            addrNode.innerHTML = labelHtml(address);
            const named = this._names.address(address, this.cpu.pc);
            if (named) {
                addrNode.append(" ", nameNode(named, address));
                shown.add(named.set);
            }
            elem.classList.toggle("current", address === this.cpu.pc);
            elem.classList.toggle("highlight", address === this.disassPc);
            elem.querySelector(".instr_bytes").textContent = dump.hex.join(" ");
            elem.querySelector(".instr_asc").textContent = dump.asc.join("");
            const disNode = elem.querySelector(".disassembly");
            disNode.innerHTML = result[0];
            const accesses = operandAccesses(result[0]);
            for (const ref of disNode.querySelectorAll(".instr_mem_ref, .instr_instr_ref")) {
                const target = parseInt(ref.dataset.ref, 10);
                const operand = this._names.operand(address, target);
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
                ref.addEventListener("click", (e) => this.memClick(e));
            }
            for (const ref of disNode.querySelectorAll(".instr_instr_ref")) {
                ref.addEventListener("click", (e) => this.instrClick(e));
            }
            elem.querySelector(".bp_gutter").classList.toggle("active", !!this.breakpoints[address]);
            elem.dataset.addr = address;
            if (result[2] !== undefined) {
                elem.dataset.ref = result[2];
            } else {
                delete elem.dataset.ref;
            }
            return result[1];
        };

        for (let i = 0; i < numToShow / 2; ++i) {
            address = updateDisElem(elems[i + numToShow / 2], address);
        }
        address = this.disassPc;
        for (let i = numToShow / 2 - 1; i >= 0; --i) {
            address = this.prevInstruction(address);
            updateDisElem(elems[i], address);
        }
        this._disassemblySets = shown;
        this._credit();
    }

    prevInstruction(address) {
        return this.cpu.disassembler.prevInstruction(address, this.cpu.pc);
    }

    updatePrevMem() {
        this._memoryView.snapshot();
    }

    hide() {
        // Only running carries a run on; a pause or a frame step ends it, as entering the debugger does.
        if (this._loop?.mode !== RunMode.running) this.cancelRun();
        this.enable(false);
    }

    /** The loop that runs the machine for the steps that need running. */
    attachLoop(loop) {
        this._loop = loop;
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

    step() {
        this.updatePrevMem();
        this.executeOne();
        this.debug(this.cpu.pc);
    }

    stepOver() {
        const { pc, s } = this.cpu;
        const [text, end, target] = this.disassemble(pc);
        const next = end & 0xffff;
        const entry = this.resetEntry();
        if (UnconditionalJump.test(text)) return this.step();
        if (Branch.test(text) && target <= pc) {
            return this.runTo(() => notDeeper(this.cpu.s, s) && (this.cpu.pc < target || this.cpu.pc > pc), false);
        }
        if (Branch.test(text)) {
            return this.runTo(() => this.cpu.pc === next || this.cpu.pc === target, next === entry || target === entry);
        }
        if (Call.test(text)) return this.runTo(() => this.cpu.pc === next && notDeeper(this.cpu.s, s), next === entry);
        this.runTo(() => this.cpu.pc === next, next === entry);
    }

    stepOut() {
        const s = this.cpu.s;
        let returning = ReturnOpcodes.has(this.cpu.peekmem(this.cpu.pc));
        this.runTo(() => {
            if (returning) return true;
            returning = notDeeper(this.cpu.s, s) && ReturnOpcodes.has(this.cpu.peekmem(this.cpu.pc));
            return false;
        }, false);
    }

    runToCursor() {
        const target = this.disassPc;
        this.runTo(() => this.cpu.pc === target, target === this.resetEntry());
    }

    nextInstruction(address) {
        return this.cpu.disassembler.nextInstruction(address);
    }

    instrClick(e) {
        const ref = parseInt(e.target.closest("[data-ref]").dataset.ref, 10);
        this.disassStack.push(this.disassPc);
        this.updateDisassembly(ref);
    }

    memClick(e) {
        const ref = parseInt(e.target.closest("[data-ref]").dataset.ref, 10);
        this._memoryView.update(ref);
    }

    toggleBreakpoint(address) {
        if (this.breakpoints[address]) {
            console.log("Removing breakpoint from address " + hexword(address));
            this.breakpoints[address].remove();
            this.breakpoints[address] = undefined;
        } else {
            console.log("Adding breakpoint to address " + hexword(address));
            this.breakpoints[address] = this.cpu.debugInstruction.add((x) => x === address);
        }
    }

    bpClick(e) {
        const disElem = e.target.closest(".dis_elem");
        const address = parseInt(disElem.dataset.addr, 10);
        this.toggleBreakpoint(address);
        e.target.closest(".bp_gutter").classList.toggle("active", !!this.breakpoints[address]);
    }

    keyPress(key) {
        if (document.activeElement && document.activeElement !== document.body) {
            return false;
        }
        switch (key) {
            case "b":
                if (this.disassStack.length) this.updateDisassembly(this.disassStack.pop());
                break;
            case "k":
                this.updateDisassembly(this.prevInstruction(this.disassPc));
                break;
            case "j":
                this.updateDisassembly(this.nextInstruction(this.disassPc));
                break;
            case "t":
                this.toggleBreakpoint(this.disassPc);
                this.updateDisassembly(this.disassPc);
                break;
            case "u":
                this._memoryView.step(8);
                break;
            case "i":
                this._memoryView.step(-8);
                break;
            case "U":
                this._memoryView.step(64);
                break;
            case "I":
                this._memoryView.step(-64);
                break;
            case "n":
                this.step();
                break;
            case "N":
                this.updatePrevMem();
                this.cpu.execute(1);
                this.debug(this.cpu.pc);
                break;
            case "m":
                this.stepOver();
                break;
            case "o":
                this.stepOut();
                break;
            case "c":
                this.runToCursor();
                break;
        }
        return true;
    }
}
