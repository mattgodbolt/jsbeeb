"use strict";
import { hexbyte, hexword, noop, parseAddr } from "../utils.js";
import { toggle } from "../dom-utils.js";

const numToShow = 16;

function labelHtml(addr) {
    return '<span class="addr">' + hexword(addr) + "</span>";
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

class MemoryView {
    constructor(widget, peekMem) {
        this._widget = widget;
        this._peekMem = peekMem;
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
        for (const row of this._rows) {
            row.querySelector(".dis_addr").innerHTML = labelHtml(addr);
            row.classList.toggle("highlight", addr === this._addr);
            const dump = this.dump(addr, addr + 8);
            const bytes = row.querySelectorAll(".mem_bytes span");
            const ascii = row.querySelectorAll(".mem_asc span");
            for (let i = 0; i < 8; ++i) {
                bytes[i].textContent = dump.hex[i];
                bytes[i].classList.toggle("changed", dump.changed[i]);
                ascii[i].textContent = dump.asc[i];
                ascii[i].classList.toggle("changed", dump.changed[i]);
            }
            addr = (addr + 8) & 0xffff;
        }
    }

    // todo extract memory part from view part and reuse in disassembler etc. also peekmem can go then
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
    constructor() {
        this.patchInstructions = new Map();
        this._enabled = false;
        this.disass = document.getElementById("disassembly");
        this._memoryView = new MemoryView(document.getElementById("memory"), (address) =>
            this.cpu ? this.cpu.peekmem(address) : 0,
        );
        this.debugNodes = document.querySelectorAll("#debug, #hardware_debug, #crtc_debug");
        this.disassPc = 0;
        this.disassStack = [];
        this.uservia = this.sysvia = this.crtc = null;
        this.breakpoints = {};

        function setupGoto(form, func) {
            const addr = form.querySelector(".goto-addr");
            form.addEventListener("submit", (e) => {
                func(parseAddr(addr.value));
                addr.value = "";
                addr.blur();
                e.preventDefault();
            });
        }

        setupGoto(document.getElementById("goto-mem-addr-form"), (address) => this._memoryView.update(address));
        setupGoto(document.getElementById("goto-dis-addr-form"), this.updateDisassembly.bind(this));

        this.enable(false);

        for (let i = 0; i < numToShow; i++) {
            cloneTemplate(this.disass);
        }

        this.disass.addEventListener("click", (e) => {
            if (e.target.closest(".bp_gutter")) this.bpClick(e);
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
            "portapins",
            "portbpins",
            "IC32",
        ];
        for (const row of node.querySelectorAll("tr:not(.template)")) row.remove();
        for (const elem of regs) {
            if (via[elem] === undefined) continue;
            const row = cloneTemplate(node);
            row.querySelector(".register").textContent = elem.toUpperCase();
            const value = row.querySelector(".value");
            if (elem.match(/t[12][cl]/)) {
                updates.push(() => {
                    const reg = via[elem];
                    this.updateElem(
                        value,
                        hexbyte((reg >>> 16) & 0xff) + hexbyte((reg >>> 8) & 0xff) + hexbyte(reg & 0xff),
                    );
                });
            } else {
                updates.push(() => {
                    this.updateElem(value, hexbyte(via[elem]));
                });
            }
        }
        const update = () => {
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
        this.enable(true);
        this.updateDisassembly(where);
        this.updateRegisters();
        this._memoryView.update();
        this.sysvia();
        this.uservia();
        this.crtc();
        this.cpu.video.debugPaint();
    }

    enable(e) {
        if (this._enabled && !e) {
            this.updatePrevMem();
        }
        this._enabled = e;
        for (const node of this.debugNodes) toggle(node, this._enabled);
    }

    enabled() {
        return this._enabled;
    }

    updateDisassembly(address) {
        this.disassPc = address;
        const elems = Array.from(this.disass.children).filter(
            (el) => el.style.display !== "none" && !el.classList.contains("template"),
        );

        const updateDisElem = (elem, address) => {
            const result = this.disassemble(address);
            const dump = this._memoryView.dump(address, result[1]);
            elem.querySelector(".dis_addr").innerHTML = labelHtml(address);
            elem.classList.toggle("current", address === this.cpu.pc);
            elem.classList.toggle("highlight", address === this.disassPc);
            elem.querySelector(".instr_bytes").textContent = dump.hex.join(" ");
            elem.querySelector(".instr_asc").textContent = dump.asc.join("");
            const disNode = elem.querySelector(".disassembly");
            disNode.innerHTML = result[0];
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
    }

    prevInstruction(address) {
        // Some attempt at making prevInstruction more accurate; score the sequence of instructions leading
        // up to the target by counting all "common" instructions as a point. The highest-scoring run of
        // instructions is picked as the most likely, and the previous from that is used. Common instructions
        // here mean loads, stores, branches, compares, arithmetic and carry-set/clear that don't use "unusual"
        // indexing modes like abs,X, abs,Y and (zp,X).
        // Good test cases:
        //   Repton 2 @ 2cbb
        //   MOS @ cfc8
        // also, just starting from the back of ROM and going up...
        const commonInstructions =
            /(RTS|B..|JMP|JSR|LD[AXY]|ST[AXY]|TA[XY]|T[XY]A|AD[DC]|SUB|SBC|CLC|SEC|CMP|EOR|ORR|AND|INC|DEC).*/;
        const uncommonInstrucions = /.*,\s*([XY]|X\))$/;

        address &= 0xffff;
        let bestAddr = address - 1;
        let bestScore = 0;
        for (let startingPoint = address - 20; startingPoint !== address; startingPoint++) {
            let score = 0;
            let addr = startingPoint & 0xffff;
            while (addr < address) {
                const result = this.disassemble(addr);
                if (result[0] === this.cpu.pc) score += 10; // huge boost if this instruction was executed
                if (result[0].match(commonInstructions) && !result[0].match(uncommonInstrucions)) {
                    score++;
                }
                if (result[1] === address) {
                    if (score > bestScore) {
                        bestScore = score;
                        bestAddr = addr;
                        break;
                    }
                }
                addr = result[1];
            }
        }
        return bestAddr;
    }

    updatePrevMem() {
        this._memoryView.snapshot();
    }

    hide() {
        this.enable(false);
    }

    stepUntil(f) {
        this.cpu.targetCycles = this.cpu.currentCycles; // TODO: this prevents the cpu from running any residual cycles. look into a better solution
        for (let i = 0; i < 65536; i++) {
            this.cpu.execute(1);
            if (f()) break;
        }
        this.debug(this.cpu.pc);
    }

    step() {
        this.updatePrevMem();
        const curpc = this.cpu.pc;
        this.stepUntil(() => this.cpu.pc !== curpc);
    }

    isUnconditionalJump(addr) {
        const result = this.disassemble(addr);
        return !!result[0].match(/^(JMP|RTS|BRA)/);
    }

    stepOver() {
        this.updatePrevMem();
        if (this.isUnconditionalJump(this.cpu.pc)) {
            return this.step();
        }
        const nextPc = this.nextInstruction(this.cpu.pc);
        this.stepUntil(() => this.cpu.pc === nextPc);
    }

    isReturn(addr) {
        const result = this.disassemble(addr);
        return result[0] === "RTS";
    }

    stepOut() {
        this.updatePrevMem();
        const s = this.cpu.s;
        this.stepUntil(() => {
            if (this.cpu.s >= s && this.isReturn(this.cpu.pc)) {
                const nextInstr = this.nextInstruction(this.cpu.pc);
                this.step();
                return this.cpu.pc !== nextInstr;
            }
            return false;
        });
    }

    nextInstruction(address) {
        return this.disassemble(address)[1] & 0xffff;
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
        switch (String.fromCharCode(key)) {
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
                self.debug(this.cpu.pc);
                break;
            case "m":
                this.stepOver();
                break;
            case "o":
                this.stepOut();
                break;
        }
        return true;
    }
}
