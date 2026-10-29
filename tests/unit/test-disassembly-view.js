// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DisassemblyView } from "../../src/web/disassembly-view.js";
import { FloatingPanel, PanelArrangement } from "../../src/web/floating-panel.js";
import { PanelKeys } from "../../src/web/panel-keys.js";
import { StartEdge } from "../../src/web/panel-layout.js";
import { NoNames } from "../../src/symbol-names.js";
import { fake6502 } from "../../src/fake6502.js";
import { findModel, TEST_65C12 } from "../../src/models.js";
import { FakeVideo } from "../../src/video.js";
import { hexbyte, parseAddr } from "../../src/hex.js";
import { domFromIndexHtml, stubResizeObserver, teardownDom } from "./helpers.js";

describe("DisassemblyView", () => {
    let cpu;
    let video;
    let keys;
    let view;
    let showMemory;
    let offerWatch;
    let runToCursor;

    const dump = (from, to) => {
        const bytes = [];
        for (let at = from; at < to; at++) bytes.push(cpu.peekmem(at));
        return { hex: bytes.map(hexbyte), asc: bytes.map((b) => (b >= 32 && b < 128 ? String.fromCharCode(b) : ".")) };
    };

    const useCpu = async (model) => {
        cpu = fake6502(model, { video });
        await cpu.initialise();
        cpu.writemem(0x2000, 0xa9);
        cpu.writemem(0x2001, 0x41);
        cpu.pc = 0x2000;
        view.setCpu(cpu);
    };

    beforeEach(async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        domFromIndexHtml("disassembly-panel");
        stubResizeObserver();
        const arrangement = new PanelArrangement(() => window.localStorage);
        keys = new PanelKeys(arrangement);
        const panel = document.getElementById("disassembly-panel");
        const floating = new FloatingPanel({
            panel,
            id: "disassembly",
            title: "Disassembly",
            group: null,
            place: () => ({ x: StartEdge, y: StartEdge }),
            minSize: { w: 100, h: 50 },
            reopens: false,
            arrangement,
        });
        showMemory = vi.fn();
        offerWatch = vi.fn();
        runToCursor = vi.fn();
        view = new DisassemblyView({
            floating,
            keys,
            names: () => NoNames,
            dump,
            resolve: parseAddr,
            showing: () => {},
            showMemory,
            offerWatch,
            runToCursor,
            refit: () => {},
        });
        video = new FakeVideo();
        await useCpu(null);
        floating.open();
    });

    afterEach(teardownDom);

    const rows = () => [...document.querySelectorAll("#disassembly .dis_elem:not(.template)")];
    const currentRow = () => document.querySelector("#disassembly .highlight");
    const addrOf = (row) => row.querySelector(".dis_addr").textContent;
    const codeAt = (address) =>
        rows()
            .find((row) => Number(row.dataset.addr) === address)
            .querySelector(".disassembly");
    const gotoBox = () => document.querySelector("#goto-dis-addr-form .goto-addr");
    const goTo = (text) => {
        gotoBox().value = text;
        gotoBox().form.dispatchEvent(new Event("submit", { cancelable: true }));
    };
    const click = (target) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    it("centres on the address asked for, with the instruction there decoded", () => {
        view.update(cpu.pc);
        expect(rows()).toHaveLength(16);
        const row = currentRow();
        expect(row.classList.contains("current")).toBe(true);
        expect(addrOf(row)).toBe("2000");
        expect(row.querySelector(".instr_bytes").textContent).toBe("a9 41");
        expect(row.querySelector(".disassembly").textContent).toBe("LDA #$41");
        expect(view.cursor).toBe(0x2000);
    });

    it("goes where the address form asks", () => {
        view.update(cpu.pc);
        goTo("$3000");
        expect(addrOf(currentRow())).toBe("3000");
        expect(currentRow().classList.contains("current")).toBe(false);
    });

    it("stays put and marks the box when the text is neither a name nor an address", () => {
        view.update(cpu.pc);
        const box = gotoBox();
        box.focus();
        goTo("monster_x");
        expect(addrOf(currentRow())).toBe("2000");
        expect(rows().map(addrOf)).not.toContain("NaN");
        expect(box.value).toBe("monster_x");
        expect(box.classList.contains("is-invalid")).toBe(true);
        expect(document.activeElement).toBe(box);
        box.dispatchEvent(new Event("input"));
        expect(box.classList.contains("is-invalid")).toBe(false);
        goTo(" ");
        expect(box.classList.contains("is-invalid")).toBe(false);
    });

    it("walks instructions with the wheel and the j and k keys", () => {
        view.update(cpu.pc);
        const disass = document.getElementById("disassembly");
        disass.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, cancelable: true }));
        expect(addrOf(currentRow())).toBe("2002");
        disass.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, cancelable: true }));
        expect(addrOf(currentRow())).toBe("2000");
        keys.press("j");
        expect(addrOf(currentRow())).toBe("2002");
        keys.press("k");
        expect(addrOf(currentRow())).toBe("2000");
    });

    it("follows a jump to its target, and comes back on b", () => {
        [0x4c, 0x00, 0x30].forEach((byte, i) => cpu.writemem(0x2002 + i, byte));
        view.update(cpu.pc);
        keys.press("j");
        click(codeAt(0x2002).querySelector(".instr_instr_ref"));
        expect(addrOf(currentRow())).toBe("3000");
        keys.press("b");
        expect(addrOf(currentRow())).toBe("2002");
        keys.press("b");
        expect(addrOf(currentRow())).toBe("2002");
    });

    it("reads an instruction straddling $ffff on from $0000, and wraps the rows below it there", () => {
        cpu.writemem(0x0000, 0x5a);
        view.update(0xfffe);
        const row = currentRow();
        const [opcode, operand] = [0xfffe, 0xffff].map((at) => hexbyte(cpu.peekmem(at)));
        expect(row.querySelector(".instr_bytes").textContent).toBe(`${opcode} ${operand} 5a`);
        expect(row.querySelector(".disassembly").textContent).toContain(`$5a${operand}`);
        expect(Number(row.nextElementSibling.dataset.addr)).toBe(0x0001);
    });

    it("toggles a breakpoint from the gutter, keeping it across a re-render", () => {
        view.update(cpu.pc);
        const gutter = () => currentRow().querySelector(".bp_gutter");
        click(gutter());
        expect(gutter().classList.contains("active")).toBe(true);
        keys.press("j");
        keys.press("k");
        expect(gutter().classList.contains("active")).toBe(true);
        click(gutter());
        expect(gutter().classList.contains("active")).toBe(false);
    });

    it("toggles a breakpoint at the cursor with the t key", () => {
        view.update(cpu.pc);
        keys.press("t");
        expect(currentRow().querySelector(".bp_gutter").classList.contains("active")).toBe(true);
    });

    describe("SHEILA registers", () => {
        const program = (bytes) => bytes.forEach((byte, i) => cpu.writemem(0x2002 + i, byte));

        it("notes the register an operand writes, reads, or both, still following it to the memory view", () => {
            program([0x8d, 0x40, 0xfe, 0xad, 0x40, 0xfe, 0xee, 0x80, 0xfe, 0x2c, 0x4d, 0xfe, 0xad, 0x00, 0x30]);
            view.update(cpu.pc);
            expect(codeAt(0x2002).textContent).toBe("STA $fe40 ; SysVIA.ORB");
            expect(codeAt(0x2002).querySelector(".note").title).toBe("System VIA ORB: $fe40");
            expect(codeAt(0x2005).textContent).toBe("LDA $fe40 ; SysVIA.IRB");
            expect(codeAt(0x2008).textContent).toBe("INC $fe80 ; FDC.STATUS/COMMAND");
            expect(codeAt(0x200b).textContent).toBe("BIT $fe4d ; SysVIA.IFR");
            expect(codeAt(0x200e).textContent).toBe("LDA $3000");
            click(codeAt(0x2002).querySelector(".instr_mem_ref"));
            expect(showMemory).toHaveBeenCalledWith(0xfe40);
        });

        it.each([
            ["STX", 0x8e, "SysVIA.ORB"],
            ["STY", 0x8c, "SysVIA.ORB"],
            ["*SAX", 0x8f, "SysVIA.ORB"],
            ["LDX", 0xae, "SysVIA.IRB"],
            ["CMP", 0xcd, "SysVIA.IRB"],
            ["*NOP", 0x0c, "SysVIA.IRB"],
            ["ASL", 0x0e, "SysVIA.IRB/ORB"],
            ["ROR", 0x6e, "SysVIA.IRB/ORB"],
            ["*SLO", 0x0f, "SysVIA.IRB/ORB"],
            ["*DCP", 0xcf, "SysVIA.IRB/ORB"],
            ["*ISB", 0xef, "SysVIA.IRB/ORB"],
        ])("takes %s's operand as the register it accesses", (mnemonic, opcode, name) => {
            program([opcode, 0x40, 0xfe]);
            view.update(cpu.pc);
            expect(codeAt(0x2002).textContent).toBe(`${mnemonic} $fe40 ; ${name}`);
        });

        it.each([
            ["STZ", 0x9c, "SysVIA.ORB"],
            ["TSB", 0x0c, "SysVIA.IRB/ORB"],
            ["TRB", 0x1c, "SysVIA.IRB/ORB"],
        ])("takes the 65C12's %s's operand as the register it accesses", async (mnemonic, opcode, name) => {
            await useCpu(TEST_65C12);
            program([opcode, 0x40, 0xfe]);
            view.update(cpu.pc);
            expect(codeAt(0x2002).textContent).toBe(`${mnemonic} $fe40 ; ${name}`);
        });

        it("names the registers of what is fitted", () => {
            video.ula.hasVideoNula = true;
            view.setCpu(cpu);
            program([0x8d, 0x22, 0xfe]);
            view.update(cpu.pc);
            expect(codeAt(0x2002).textContent).toBe("STA $fe22 ; VideoULA.NULA_CONTROL");
        });

        it("leaves a jump into SHEILA as an address", () => {
            program([0x20, 0x40, 0xfe]);
            view.update(cpu.pc);
            expect(codeAt(0x2002).textContent).toBe("JSR $fe40");
        });

        it("names the registers the model has where it has them", async () => {
            const master = findModel("Master");
            await useCpu(Object.assign(Object.create(Object.getPrototypeOf(master)), master, { os: [] }));
            program([0x8d, 0x34, 0xfe, 0x8d, 0x28, 0xfe, 0xad, 0x80, 0xfe]);
            view.update(cpu.pc);
            expect(codeAt(0x2002).textContent).toBe("STA $fe34 ; Paging.ACCCON");
            expect(codeAt(0x2005).textContent).toBe("STA $fe28 ; FDC.COMMAND");
            expect(codeAt(0x2008).textContent).toBe("LDA $fe80");
        });

        it("offers a register to watch by its name from a right-click", () => {
            program([0x8d, 0x40, 0xfe]);
            view.update(cpu.pc);
            codeAt(0x2002)
                .querySelector(".instr_mem_ref")
                .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
            expect(offerWatch).toHaveBeenCalledWith(expect.any(MouseEvent), 0xfe40, "SysVIA.ORB");
        });
    });
});
