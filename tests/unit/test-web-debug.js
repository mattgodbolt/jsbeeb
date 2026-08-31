// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Debugger } from "../../src/web/debug.js";
import { fake6502 } from "../../src/fake6502.js";
import { FakeVideo } from "../../src/video.js";
import { teardownDom } from "./helpers.js";

const templateRow = '<tr class="template"><th><span class="register"></span>:</th><td class="value"></td></tr>';
const Markup = `
<div id="crtc_debug">
  <div class="crtc_state"><table><tbody>${templateRow}</tbody></table></div>
  <div class="crtc_regs"><table><tbody>${templateRow}</tbody></table></div>
</div>
<div id="debug">
  <form id="goto-mem-addr-form"><input class="goto-addr" /></form>
  <div id="memory">
    <div class="template">
      <span class="dis_addr"></span>
      <span class="mem_bytes">${"<span></span>".repeat(8)}</span>
      <span class="mem_asc">${"<span></span>".repeat(8)}</span>
    </div>
  </div>
  <form id="goto-dis-addr-form"><input class="goto-addr" /></form>
  <div id="disassembly">
    <div class="template dis_elem">
      <span class="bp_gutter"></span><span class="dis_addr"></span><span class="instr_bytes"></span
      ><span class="instr_asc"></span><span class="disassembly"></span>
    </div>
  </div>
  <span id="cpu6502_a"></span><span id="cpu6502_x"></span><span id="cpu6502_y"></span>
  <span id="cpu6502_s"></span><span id="cpu6502_pc"></span>
  <span id="cpu6502_flag_c"></span><span id="cpu6502_flag_z"></span><span id="cpu6502_flag_i"></span>
  <span id="cpu6502_flag_d"></span><span id="cpu6502_flag_v"></span><span id="cpu6502_flag_n"></span>
</div>
<div id="hardware_debug">
  <div id="sysvia"><table><tbody>${templateRow}</tbody></table></div>
  <div id="uservia"><table><tbody>${templateRow}</tbody></table></div>
</div>`;

describe("Debugger", () => {
    let cpu;
    let video;
    let dbgr;

    beforeEach(async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        document.body.innerHTML = Markup;
        video = new FakeVideo();
        video.debugPaint = vi.fn();
        cpu = fake6502(null, { video });
        await cpu.initialise();
        cpu.writemem(0x2000, 0xa9);
        cpu.writemem(0x2001, 0x41);
        cpu.pc = 0x2000;
        dbgr = new Debugger();
        dbgr.setCpu(cpu);
    });

    afterEach(teardownDom);

    const visible = (id) => document.getElementById(id).style.display !== "none";
    const disRows = () => [...document.querySelectorAll("#disassembly .dis_elem:not(.template)")];
    const currentRow = () => document.querySelector("#disassembly .highlight");
    const memHighlight = () => document.querySelector("#memory .highlight");
    const keyPress = (char) => dbgr.keyPress(char.charCodeAt(0));

    describe("the panels", () => {
        it("start hidden and show when the debugger is entered", () => {
            expect(visible("debug")).toBe(false);
            expect(visible("hardware_debug")).toBe(false);
            expect(visible("crtc_debug")).toBe(false);
            dbgr.debug(cpu.pc);
            expect(dbgr.enabled()).toBe(true);
            expect(visible("debug")).toBe(true);
            expect(visible("hardware_debug")).toBe(true);
        });

        it("hide again on leaving", () => {
            dbgr.debug(cpu.pc);
            dbgr.hide();
            expect(dbgr.enabled()).toBe(false);
            expect(visible("debug")).toBe(false);
        });
    });

    describe("the disassembly window", () => {
        it("centres on the program counter with the instruction decoded", () => {
            dbgr.debug(cpu.pc);
            expect(disRows()).toHaveLength(16);
            const row = currentRow();
            expect(row.classList.contains("current")).toBe(true);
            expect(row.querySelector(".dis_addr").textContent).toBe("2000");
            expect(row.querySelector(".instr_bytes").textContent).toBe("a9 41");
            expect(row.querySelector(".disassembly").textContent).toBe("LDA #$41");
            expect(video.debugPaint).toHaveBeenCalled();
        });

        it("goes where the address form asks", () => {
            dbgr.debug(cpu.pc);
            const form = document.getElementById("goto-dis-addr-form");
            form.querySelector(".goto-addr").value = "$3000";
            form.dispatchEvent(new Event("submit", { cancelable: true }));
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("3000");
        });

        it("walks instructions with the wheel and the j and k keys", () => {
            dbgr.debug(cpu.pc);
            const disass = document.getElementById("disassembly");
            disass.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, cancelable: true }));
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("2002");
            disass.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, cancelable: true }));
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("2000");
            keyPress("j");
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("2002");
            keyPress("k");
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("2000");
        });

        it("toggles a breakpoint from the gutter, keeping it across a re-render", () => {
            dbgr.debug(cpu.pc);
            const gutter = () => currentRow().querySelector(".bp_gutter");
            gutter().dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(gutter().classList.contains("active")).toBe(true);
            keyPress("j");
            keyPress("k");
            expect(gutter().classList.contains("active")).toBe(true);
            gutter().dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(gutter().classList.contains("active")).toBe(false);
        });

        it("toggles a breakpoint at the cursor with the t key", () => {
            dbgr.debug(cpu.pc);
            keyPress("t");
            expect(currentRow().querySelector(".bp_gutter").classList.contains("active")).toBe(true);
        });
    });

    describe("the memory window", () => {
        it("shows the bytes and text around the address the form asks for", () => {
            cpu.writemem(0x1234, 0x48);
            dbgr.debug(cpu.pc);
            const form = document.getElementById("goto-mem-addr-form");
            form.querySelector(".goto-addr").value = "$1234";
            form.dispatchEvent(new Event("submit", { cancelable: true }));
            const row = memHighlight();
            expect(row.querySelector(".dis_addr").textContent).toBe("1234");
            expect(row.querySelector(".mem_bytes span").textContent).toBe("48");
            expect(row.querySelector(".mem_asc span").textContent).toBe("H");
        });

        it("marks bytes changed since the last debugger visit, forgetting them on leaving", () => {
            const gotoMem = (value) => {
                const form = document.getElementById("goto-mem-addr-form");
                form.querySelector(".goto-addr").value = value;
                form.dispatchEvent(new Event("submit", { cancelable: true }));
            };
            const changed = () => memHighlight().querySelector(".mem_bytes span").classList.contains("changed");
            dbgr.debug(cpu.pc);
            dbgr.hide();
            dbgr.debug(cpu.pc);
            gotoMem("$1234");
            expect(changed()).toBe(false);
            cpu.writemem(0x1234, 0x48);
            gotoMem("$1234");
            expect(changed()).toBe(true);
            dbgr.hide();
            dbgr.debug(cpu.pc);
            gotoMem("$1234");
            expect(changed()).toBe(false);
        });

        it("scrolls a row per wheel notch and a screenful on U", () => {
            dbgr.debug(cpu.pc);
            const form = document.getElementById("goto-mem-addr-form");
            form.querySelector(".goto-addr").value = "$1000";
            form.dispatchEvent(new Event("submit", { cancelable: true }));
            document.getElementById("memory").dispatchEvent(new WheelEvent("wheel", { deltaY: 20, cancelable: true }));
            expect(memHighlight().querySelector(".dis_addr").textContent).toBe("1008");
            keyPress("u");
            expect(memHighlight().querySelector(".dis_addr").textContent).toBe("1010");
            keyPress("I");
            expect(memHighlight().querySelector(".dis_addr").textContent).toBe("0fd0");
        });
    });

    describe("the keyboard", () => {
        it("steps one instruction on n and shows its effect", () => {
            dbgr.debug(cpu.pc);
            keyPress("n");
            expect(document.getElementById("cpu6502_a").textContent).toBe("41");
            expect(document.getElementById("cpu6502_pc").textContent).toBe("2002");
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("2002");
        });

        it("leaves the keys alone while a form field has focus", () => {
            dbgr.debug(cpu.pc);
            document.querySelector("#goto-dis-addr-form .goto-addr").focus();
            expect(keyPress("j")).toBe(false);
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("2000");
        });
    });

    describe("the hardware panels", () => {
        it("lists the VIA registers with their values", () => {
            const rows = [...document.querySelectorAll("#sysvia tr:not(.template)")];
            const named = Object.fromEntries(
                rows.map((row) => [row.querySelector(".register").textContent, row.querySelector(".value")]),
            );
            expect(Object.keys(named)).toContain("ORA");
            expect(Object.keys(named)).toContain("IC32");
            expect(named.ORA.textContent).toBe("00");
            expect(named.T1C.textContent).toHaveLength(6);
        });

        it("lists the CRTC registers and state", () => {
            const regRows = [...document.querySelectorAll("#crtc_debug .crtc_regs tr:not(.template)")];
            expect(regRows.map((row) => row.querySelector(".register").textContent)).toHaveLength(16);
            expect(regRows[0].querySelector(".register").textContent).toBe("R0");
            expect(regRows[0].querySelector(".value").textContent).toBe("00");
            const stateRows = [...document.querySelectorAll("#crtc_debug .crtc_state tr:not(.template)")];
            expect(stateRows.map((row) => row.querySelector(".register").textContent)).toContain("vertCounter");
        });
    });

    describe("patches", () => {
        it("pokes bytes from a patch string", () => {
            dbgr.execPatch("3000:ea4c");
            expect(cpu.peekmem(0x3000)).toBe(0xea);
            expect(cpu.peekmem(0x3001)).toBe(0x4c);
        });

        it("applies an unconditional patch immediately", () => {
            dbgr.setPatch("3000:ea;3010:60");
            expect(cpu.peekmem(0x3000)).toBe(0xea);
            expect(cpu.peekmem(0x3010)).toBe(0x60);
        });

        it("holds an @-patch until the program counter arrives", () => {
            dbgr.setPatch("@20003000:ea");
            expect(cpu.peekmem(0x3000)).toBe(0xff);
            dbgr.debug(cpu.pc);
            keyPress("n");
            expect(cpu.peekmem(0x3000)).toBe(0xea);
        });
    });
});
