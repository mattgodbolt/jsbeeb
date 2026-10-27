// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Debugger } from "../../src/web/debug.js";
import { fake6502 } from "../../src/fake6502.js";
import { findModel } from "../../src/models.js";
import { FakeVideo } from "../../src/video.js";
import { hexbyte, hexword } from "../../src/hex.js";
import { SymbolSets } from "../../src/symbol-sets.js";
import { domFromIndexHtml, sentEvents, teardownDom } from "./helpers.js";

describe("Debugger", () => {
    let cpu;
    let video;
    let dbgr;

    beforeEach(async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        domFromIndexHtml("crtc_debug", "debug", "hardware_debug", "watch-panel", "watch-menu", "watch-open");
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
    const keyPress = (char) => dbgr.keyPress(char);
    const addrOf = (row) => row.querySelector(".dis_addr").textContent;
    const goTo = (formId, text) => {
        const form = document.getElementById(formId);
        form.querySelector(".goto-addr").value = text;
        form.dispatchEvent(new Event("submit", { cancelable: true }));
    };

    /** The byte's span, in a view whose rows start on a multiple of 8. */
    const memByte = (address) =>
        [...document.querySelectorAll("#memory > div")]
            .find((row) => addrOf(row) === hexword(address & ~7))
            .querySelectorAll(".mem_bytes span")[address & 7];
    const watchBox = () => document.getElementById("watch-add");
    const addWatch = (text) => {
        watchBox().value = text;
        document.getElementById("watch-add-form").dispatchEvent(new Event("submit", { cancelable: true }));
    };
    const watchRows = () =>
        [...document.querySelectorAll("#watch-panel .watch-list tr:not(.watch-formats)")].map((row) =>
            [...row.querySelectorAll("td")].map(
                (td) => td.querySelector(".watch-format")?.textContent ?? td.textContent,
            ),
        );
    const watchRow = (index) => document.querySelectorAll("#watch-panel .watch-list tr:not(.watch-formats)")[index];
    const watchControl = (index, className) => watchRow(index).querySelector(`.${className}`);
    const watchChoices = (index) => watchRow(index).nextElementSibling;
    const watchMenu = () => document.getElementById("watch-menu");
    const rightClick = (target) =>
        target.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }),
        );
    const pickFromMenu = (text) =>
        [...watchMenu().querySelectorAll("button")].find((choice) => choice.textContent === text).click();

    describe("the panels", () => {
        it("start hidden, show when the debugger is entered, and hide again on leaving", () => {
            expect(visible("debug")).toBe(false);
            expect(visible("hardware_debug")).toBe(false);
            expect(visible("crtc_debug")).toBe(false);
            dbgr.debug(cpu.pc);
            expect(dbgr.enabled()).toBe(true);
            expect(visible("debug")).toBe(true);
            expect(visible("hardware_debug")).toBe(true);
            dbgr.hide();
            expect(dbgr.enabled()).toBe(false);
            expect(visible("debug")).toBe(false);
        });

        it("note the debugger opening each time it is entered, not each time it stops", () => {
            const sent = sentEvents();
            dbgr.debug(cpu.pc);
            dbgr.debug(cpu.pc);
            dbgr.hide();
            dbgr.debug(cpu.pc);
            expect(sent("feature_used")).toEqual([
                { feature: "debugger", action: "open" },
                { feature: "debugger", action: "open" },
            ]);
        });

        it.each([
            [
                "gives the keyboard back to the machine from a goto box",
                () => document.querySelector("#goto-dis-addr-form .goto-addr"),
                false,
            ],
            [
                "leaves focus alone elsewhere on the page",
                () => document.body.appendChild(document.createElement("input")),
                true,
            ],
        ])("%s on leaving", (_, focused, keeps) => {
            dbgr.debug(cpu.pc);
            const el = focused();
            el.focus();
            dbgr.hide();
            expect(document.activeElement === el).toBe(keeps);
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
            goTo("goto-dis-addr-form", "$3000");
            expect(addrOf(currentRow())).toBe("3000");
        });

        it("stays put and marks the box when the text is neither a name nor an address", () => {
            dbgr.debug(cpu.pc);
            const box = document.querySelector("#goto-dis-addr-form .goto-addr");
            box.focus();
            box.value = "monster_x";
            box.form.dispatchEvent(new Event("submit", { cancelable: true }));
            expect(addrOf(currentRow())).toBe("2000");
            expect(disRows().map((row) => row.querySelector(".dis_addr").textContent)).not.toContain("NaN");
            expect(box.value).toBe("monster_x");
            expect(box.classList.contains("is-invalid")).toBe(true);
            expect(document.activeElement).toBe(box);
            box.dispatchEvent(new Event("input"));
            expect(box.classList.contains("is-invalid")).toBe(false);
            box.value = " ";
            box.form.dispatchEvent(new Event("submit", { cancelable: true }));
            expect(box.classList.contains("is-invalid")).toBe(false);
        });

        it("leaves the memory view alone too when the text is neither a name nor an address", () => {
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$1234");
            goTo("goto-mem-addr-form", "monster_x");
            const box = document.querySelector("#goto-mem-addr-form .goto-addr");
            expect(addrOf(memHighlight())).toBe("1234");
            expect(box.classList.contains("is-invalid")).toBe(true);
        });

        it("walks instructions with the wheel and the j and k keys", () => {
            dbgr.debug(cpu.pc);
            const disass = document.getElementById("disassembly");
            disass.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, cancelable: true }));
            expect(addrOf(currentRow())).toBe("2002");
            disass.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, cancelable: true }));
            expect(addrOf(currentRow())).toBe("2000");
            keyPress("j");
            expect(addrOf(currentRow())).toBe("2002");
            keyPress("k");
            expect(addrOf(currentRow())).toBe("2000");
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
            goTo("goto-mem-addr-form", "$1234");
            const row = memHighlight();
            expect(row.querySelector(".dis_addr").textContent).toBe("1234");
            expect(row.querySelector(".mem_bytes span").textContent).toBe("48");
            expect(row.querySelector(".mem_asc span").textContent).toBe("H");
        });

        it("marks bytes changed since the last debugger visit, forgetting them on leaving", () => {
            const gotoMem = (value) => goTo("goto-mem-addr-form", value);
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

        it("shows a hardware register without the side effects of reading it", async () => {
            const SysViaOra = 0xfe41;
            const SysViaIfr = 0xfe4d;
            const Ca1Flag = 0x02;
            // The test CPU has no I/O, so a BBC B, without the ROMs jsdom cannot fetch.
            const beeb = findModel("B-DFS1.2");
            cpu = fake6502(Object.assign(Object.create(Object.getPrototypeOf(beeb)), beeb, { os: [] }), { video });
            await cpu.initialise();
            dbgr.setCpu(cpu);
            cpu.sysvia.setVBlankInt(true);
            cpu.sysvia.setVBlankInt(false);
            expect(cpu.peekmem(SysViaIfr) & Ca1Flag).toBe(Ca1Flag);
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$FE41");
            expect(memHighlight().querySelector(".mem_bytes span").textContent).toBe(hexbyte(cpu.peekmem(SysViaOra)));
            expect(cpu.peekmem(SysViaIfr) & Ca1Flag).toBe(Ca1Flag);
        });

        it("scrolls a row per wheel notch and a screenful on U", () => {
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$1000");
            document.getElementById("memory").dispatchEvent(new WheelEvent("wheel", { deltaY: 20, cancelable: true }));
            expect(addrOf(memHighlight())).toBe("1008");
            keyPress("u");
            expect(addrOf(memHighlight())).toBe("1010");
            keyPress("I");
            expect(addrOf(memHighlight())).toBe("0fd0");
        });
    });

    describe("the keyboard", () => {
        it("steps one instruction on n and shows its effect", () => {
            dbgr.debug(cpu.pc);
            keyPress("n");
            expect(document.getElementById("cpu6502_a").textContent).toBe("41");
            expect(document.getElementById("cpu6502_pc").textContent).toBe("2002");
            expect(addrOf(currentRow())).toBe("2002");
        });

        it("leaves the keys alone while a form field has focus", () => {
            dbgr.debug(cpu.pc);
            document.querySelector("#goto-dis-addr-form .goto-addr").focus();
            expect(keyPress("j")).toBe(false);
            expect(addrOf(currentRow())).toBe("2000");
        });
    });

    describe("the watch panel", () => {
        let frames;
        const runFrame = () => {
            const pending = [...frames.values()];
            frames.clear();
            for (const callback of pending) callback();
        };

        beforeEach(() => {
            frames = new Map();
            let handle = 0;
            vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
                frames.set(++handle, callback);
                return handle;
            });
            vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id));
            cpu.writemem(0x70, 0x05);
            cpu.writemem(0x71, 0x01);
        });

        afterEach(() => vi.restoreAllMocks());

        const panelOpen = () => !document.getElementById("watch-panel").hidden;
        const openFromMenu = () => document.getElementById("watch-open").click();

        it("takes an address while the machine runs, giving the keyboard back once it is added", () => {
            openFromMenu();
            watchBox().focus();
            expect(document.activeElement).toBe(watchBox());
            addWatch("$70");
            expect(document.activeElement).not.toBe(watchBox());
            expect(watchBox().value).toBe("");
            expect(watchRows()).toEqual([["$0070", "5", "dec", "\u00d7"]]);
        });

        it("gives the keyboard back on Escape, keeping the panel open and the Escape from the machine", () => {
            const pageSaw = vi.fn();
            document.addEventListener("keydown", pageSaw);
            openFromMenu();
            watchBox().focus();
            watchBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            document.removeEventListener("keydown", pageSaw);
            expect(document.activeElement).not.toBe(watchBox());
            expect(panelOpen()).toBe(true);
            expect(pageSaw).not.toHaveBeenCalled();
        });

        it("reads its watches once a frame, without side effects, while open, and not at all while closed", () => {
            dbgr.debug(cpu.pc);
            addWatch("$70");
            dbgr.hide();
            const peek = vi.spyOn(cpu, "peekmem");
            const read = vi.spyOn(cpu, "readmem");
            openFromMenu();
            expect(panelOpen()).toBe(true);
            peek.mockClear();
            cpu.writemem(0x70, 0x06);
            runFrame();
            expect(watchRows()[0][1]).toBe("6");
            expect(peek).toHaveBeenCalledTimes(1);
            expect(frames.size).toBe(1);
            openFromMenu();
            expect(panelOpen()).toBe(false);
            expect(frames.size).toBe(0);
            peek.mockClear();
            cpu.writemem(0x70, 0x07);
            runFrame();
            expect(peek).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
            expect(watchRows()[0][1]).toBe("6");
        });

        it("shows a watch in the format picked from its list, reading as many bytes as each needs", () => {
            dbgr.debug(cpu.pc);
            addWatch("$70");
            const shown = [];
            for (const name of ["dec", "hex", "dec16", "hex16", "dec32", "hex32"]) {
                watchControl(0, "watch-format").click();
                const choices = watchChoices(0);
                expect(choices.hidden).toBe(false);
                [...choices.querySelectorAll("button")].find((choice) => choice.textContent === name).click();
                expect(choices.hidden).toBe(true);
                shown.push(watchRows()[0].slice(1, 3).join(" "));
            }
            expect(shown).toEqual(["5 dec", "$05 hex", "261 dec16", "$0105 hex16", "261 dec32", "$00000105 hex32"]);
        });

        it("closes the list of formats on a click anywhere else, on another watch's, or on closing the panel", () => {
            dbgr.debug(cpu.pc);
            addWatch("$70");
            addWatch("$71");
            const press = (target) => target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
            watchControl(0, "watch-format").click();
            press(document.body);
            expect(watchChoices(0).hidden).toBe(true);
            watchControl(0, "watch-format").click();
            press(watchControl(1, "watch-format"));
            watchControl(1, "watch-format").click();
            expect(watchChoices(0).hidden).toBe(true);
            expect(watchChoices(1).hidden).toBe(false);
            openFromMenu();
            openFromMenu();
            expect(watchChoices(1).hidden).toBe(true);
            expect(watchRows()[0][2]).toBe("dec");
        });

        it("offers a menu of every format on a right-click on a memory byte, adding the watch picked", () => {
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$70");
            const click = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
            memByte(0x70).dispatchEvent(click);
            expect(click.defaultPrevented).toBe(true);
            expect(watchMenu().hidden).toBe(false);
            expect([...watchMenu().querySelectorAll("button")].map((choice) => choice.textContent)).toEqual(
                ["dec", "hex", "dec16", "hex16", "dec32", "hex32"].map((name) => `Watch ${name}`),
            );
            expect(panelOpen()).toBe(false);
            pickFromMenu("Watch hex16");
            expect(watchMenu().hidden).toBe(true);
            expect(panelOpen()).toBe(true);
            expect(watchRows()).toEqual([["$0070", "$0105", "hex16", "\u00d7"]]);
        });

        it("closes the menu on a click elsewhere, or on Escape, which goes on to the page", () => {
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$70");
            rightClick(memByte(0x70));
            expect(watchMenu().hidden).toBe(false);
            document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
            expect(watchMenu().hidden).toBe(true);
            rightClick(memByte(0x71));
            const pageSaw = vi.fn();
            document.addEventListener("keydown", pageSaw);
            document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            document.removeEventListener("keydown", pageSaw);
            expect(watchMenu().hidden).toBe(true);
            expect(pageSaw).toHaveBeenCalledOnce();
            expect(watchRows()).toEqual([]);
        });

        it("closes the menu on leaving the debugger", () => {
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$70");
            rightClick(memByte(0x70));
            dbgr.hide();
            expect(watchMenu().hidden).toBe(true);
        });

        it("closes a watch's list of formats on Escape too", () => {
            dbgr.debug(cpu.pc);
            addWatch("$70");
            watchControl(0, "watch-format").click();
            document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            expect(watchChoices(0).hidden).toBe(true);
        });

        it("leaves the browser's own menu to a right-click on an instruction's mnemonic or bytes", () => {
            dbgr.debug(cpu.pc);
            for (const target of [
                currentRow().querySelector(".disassembly"),
                currentRow().querySelector(".instr_bytes"),
            ]) {
                const click = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
                target.dispatchEvent(click);
                expect(click.defaultPrevented).toBe(false);
            }
            expect(watchMenu().hidden).toBe(true);
        });

        it("keeps the menu's buttons from focus, by mouse or by Tab", () => {
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$70");
            rightClick(memByte(0x70));
            for (const choice of watchMenu().querySelectorAll("button")) {
                const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                choice.dispatchEvent(press);
                expect(press.defaultPrevented).toBe(true);
                expect(choice.tabIndex).toBe(-1);
            }
        });

        it("stops watching on the remove button, saying so once the list is empty", () => {
            const empty = () => document.querySelector("#watch-panel .watch-empty").hidden === false;
            expect(empty()).toBe(true);
            dbgr.debug(cpu.pc);
            addWatch("$70");
            addWatch("$71");
            expect(empty()).toBe(false);
            watchControl(0, "watch-remove").click();
            expect(watchRows().map(([name]) => name)).toEqual(["$0071"]);
            watchControl(0, "watch-remove").click();
            expect(watchRows()).toEqual([]);
            expect(document.querySelectorAll("#watch-panel .watch-list tr")).toHaveLength(0);
            expect(empty()).toBe(true);
        });

        it("keeps its buttons from focus, by mouse or by Tab", () => {
            dbgr.debug(cpu.pc);
            addWatch("$70");
            for (const button of [
                watchControl(0, "watch-format"),
                watchChoices(0).querySelector("button"),
                watchControl(0, "watch-remove"),
            ]) {
                const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                button.dispatchEvent(press);
                expect(press.defaultPrevented).toBe(true);
                expect(button.tabIndex).toBe(-1);
            }
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

    describe("names from symbol sets", () => {
        const BaseUrl = "https://symbols.example/";
        const OswrchAt = 0x3000;
        const mosRegion = { start: "0x3000", end: "0x3100", anchors: [{ at: "0x3000", bytes: "6c0e0260" }] };
        const files = new Map([
            [
                `${BaseUrl}index.json`,
                { format: 1, sets: [{ url: "mos.json", licence: "MIT", regions: { rom: mosRegion } }] },
            ],
            [
                `${BaseUrl}mos.json`,
                {
                    format: 1,
                    title: "Test MOS",
                    licence: "MIT",
                    source: "https://example.com/mos.lst",
                    notice: "Copyright the test",
                    system: true,
                    globals: { os_text_ptr: "0xf2", wrchv: "0x20e", system_via_register_b: "0xfe40" },
                    regions: { rom: { ...mosRegion, symbols: { oswrch: "0x3000" } } },
                },
            ],
        ]);
        let load;
        /** Serves the sets with `change` made to the MOS's. */
        const withMos = (change) =>
            load.mockImplementation(async (url) => {
                const json = structuredClone(files.get(url));
                if (url.endsWith("mos.json")) change(json);
                return json;
            });
        const rowAt = (address) => disRows().find((row) => Number(row.dataset.addr) === address);
        const code = (address) => rowAt(address).querySelector(".disassembly");
        const symbolsLine = () => document.getElementById("debug-symbols");
        const credited = () => symbolsLine().style.visibility !== "hidden";

        beforeEach(() => {
            [0x20, 0x00, 0x30, 0x8d, 0x40, 0xfe, 0xb1, 0xf2, 0x6c, 0x0e, 0x02, 0xa5, 0xf2].forEach((byte, i) =>
                cpu.writemem(0x2002 + i, byte),
            );
            [0x6c, 0x0e, 0x02, 0x60, 0xd0, 0xfa].forEach((byte, i) => cpu.writemem(OswrchAt + i, byte));
            load = vi.fn(async (url) => structuredClone(files.get(url)));
            document.body.innerHTML = "";
            domFromIndexHtml("crtc_debug", "debug", "hardware_debug", "watch-panel", "watch-menu", "watch-open");
            dbgr = new Debugger({ symbolSets: new SymbolSets({ baseUrl: BaseUrl, load }) });
            dbgr.setCpu(cpu);
        });

        it("names operands once the sets that match have arrived, and says where the names came from", async () => {
            dbgr.debug(cpu.pc);
            expect(code(0x2002).textContent).toBe("JSR $3000");
            expect(credited()).toBe(false);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            expect(code(0x2005).textContent).toBe("STA system_via_register_b");
            expect(code(0x2008).textContent).toMatch(/^LDA \(os_text_ptr\),Y ; \$[0-9a-f]{4} \+ Y$/);
            expect(code(0x200a).textContent).toMatch(/^JMP \(wrchv\) ; \$/);
            expect(code(0x200d).textContent).toBe("LDA os_text_ptr");
            expect(code(0x2000).textContent).toBe("LDA #$41");
            expect(code(0x2002).querySelector(".instr_instr_ref").title).toBe("oswrch: $3000, from Test MOS");
            expect(credited()).toBe(true);
            expect(symbolsLine().textContent).toBe("names from Test MOS (source)");
            expect(symbolsLine().querySelector(".symbol-set").title).toBe("MIT\n\nCopyright the test");
            expect(symbolsLine().querySelector("a").href).toBe("https://example.com/mos.lst");
        });

        it("names an address in the address column, and still follows a named operand", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            expect(addrOf(rowAt(0x2002))).toBe("2002");
            code(0x2002)
                .querySelector(".instr_instr_ref")
                .dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(addrOf(currentRow())).toBe("3000 oswrch");
            expect(currentRow().querySelector(".dis_addr .symbol").title).toBe("oswrch: $3000, from Test MOS");
            expect(code(0x3004).textContent).toBe("BNE oswrch");
        });

        it("goes to a name typed in either box, over reading it as hex", async () => {
            withMos((mos) => (mos.regions.rom.symbols.fade = "0x3004"));
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            const box = document.querySelector("#goto-dis-addr-form .goto-addr");
            box.focus();
            goTo("goto-dis-addr-form", " oswrch ");
            expect(addrOf(currentRow())).toBe("3000 oswrch");
            expect(box.value).toBe("");
            expect(document.activeElement).not.toBe(box);
            goTo("goto-dis-addr-form", "fade");
            expect(addrOf(currentRow())).toBe("3004 fade");
            goTo("goto-dis-addr-form", "$fade");
            expect(addrOf(currentRow())).toBe("fade");
            goTo("goto-dis-addr-form", "FADE");
            expect(addrOf(currentRow())).toBe("fade");
            goTo("goto-dis-addr-form", "OSWRCH");
            expect(box.classList.contains("is-invalid")).toBe(true);
            goTo("goto-dis-addr-form", "oswrch");
            expect(box.classList.contains("is-invalid")).toBe(false);
            goTo("goto-mem-addr-form", "os_text_ptr");
            expect(addrOf(memHighlight())).toBe("00f2");
        });

        it("still follows a named zero-page operand to the memory view", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x200d).textContent).toBe("LDA os_text_ptr"));
            code(0x200d)
                .querySelector(".instr_mem_ref")
                .dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(addrOf(memHighlight())).toBe("00f2");
        });

        it.each([
            ["a source", { source: "javascript:alert(1)" }, "names from Test MOS (javascript:alert(1))", []],
            [
                "a home",
                { home: "javascript:alert(1)" },
                "names from Test MOS (source)",
                ["https://example.com/mos.lst"],
            ],
        ])("shows %s that isn't https as no link", async (_, change, credit, links) => {
            withMos((mos) => Object.assign(mos, change));
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            expect(symbolsLine().textContent).toBe(credit);
            expect([...symbolsLine().querySelectorAll("a")].map((a) => a.href)).toEqual(links);
        });

        it("credits only the sets naming something in view, following the view as it moves", async () => {
            const OtherAt = 0x5000;
            const otherRegion = { start: "0x5000", end: "0x5100", anchors: [{ at: "0x5000", bytes: "eaea" }] };
            [0xea, 0xea].forEach((byte, i) => cpu.writemem(OtherAt + i, byte));
            const withOther = new Map([
                ...files,
                [
                    `${BaseUrl}index.json`,
                    {
                        format: 1,
                        sets: [
                            ...files.get(`${BaseUrl}index.json`).sets,
                            { url: "other.json", licence: "MIT", regions: { code: otherRegion } },
                        ],
                    },
                ],
                [
                    `${BaseUrl}other.json`,
                    {
                        format: 1,
                        title: "Other",
                        licence: "MIT",
                        source: "https://example.com/other.lst",
                        regions: { code: { ...otherRegion, symbols: { start: "0x5000" } } },
                    },
                ],
            ]);
            load.mockImplementation(async (url) => structuredClone(withOther.get(url)));
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => {
                dbgr.updateDisassembly(OtherAt);
                expect(symbolsLine().textContent).toBe("names from Other (source)");
            });
            dbgr.updateDisassembly(cpu.pc);
            expect(symbolsLine().textContent).toBe("names from Test MOS (source)");
            [0x4c, OtherAt & 0xff, OtherAt >> 8].forEach((byte, i) => cpu.writemem(0x2002 + i, byte));
            keyPress("n");
            expect(code(0x2002).textContent).toBe("JMP start");
            expect(symbolsLine().textContent).toBe("names from Test MOS (source) · Other (source)");
        });

        it("marks a matching region's bytes in the memory view, with its name and any byte's own on hover", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            goTo("goto-mem-addr-form", "$3000");
            const marks = (address) =>
                ["region", "region-start"].filter((mark) => memByte(address).classList.contains(mark));
            expect(marks(0x2fff)).toEqual([]);
            expect(memByte(0x2fff).title).toBe("");
            expect(marks(0x3000)).toEqual(["region", "region-start"]);
            expect(memByte(0x3000).title).toBe("oswrch: $3000\nin rom, $3000-$30ff, from Test MOS");
            expect(marks(0x3001)).toEqual(["region"]);
            expect(memByte(0x3001).title).toBe("$3001\nin rom, $3000-$30ff, from Test MOS");
            goTo("goto-mem-addr-form", "$f0");
            expect(marks(0xf2)).toEqual([]);
            expect(memByte(0xf2).title).toBe("os_text_ptr: $00f2");
        });

        it("credits a set whose names only the memory view shows", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            dbgr.updateDisassembly(0x8000);
            expect(credited()).toBe(false);
            goTo("goto-mem-addr-form", "$3000");
            expect(symbolsLine().textContent).toBe("names from Test MOS (source)");
            goTo("goto-mem-addr-form", "$1000");
            expect(credited()).toBe(false);
        });

        it("watches a name typed while the machine runs, once opening the panel has fetched its set", async () => {
            document.getElementById("watch-open").click();
            await vi.waitFor(() => expect(load).toHaveBeenCalledWith(`${BaseUrl}mos.json`));
            await vi.waitFor(() => expect(load.mock.settledResults.at(-1)?.type).toBe("fulfilled"));
            await new Promise((resolve) => setTimeout(resolve, 0));
            addWatch("oswrch");
            expect(watchRows()).toEqual([["oswrch", "108", "dec", "\u00d7"]]);
            expect(dbgr.enabled()).toBe(false);
            document.getElementById("watch-close").click();
        });

        it("watches a name, or an address by its name, and refuses a word that is neither", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            addWatch("oswrch");
            addWatch("$3001");
            addWatch("$f2");
            addWatch("nobody");
            expect(watchBox().classList.contains("is-invalid")).toBe(true);
            expect(watchRows()).toEqual([
                ["oswrch", "108", "dec", "\u00d7"],
                ["$3001", "14", "dec", "\u00d7"],
                ["os_text_ptr", "0", "dec", "\u00d7"],
            ]);
        });

        it("labels a watch with the name typed, even one the address isn't shown by here", async () => {
            withMos((mos) => (mos.workspace = { scratch: "0x70" }));
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            addWatch("scratch");
            addWatch("$70");
            expect(watchRows().map(([name]) => name)).toEqual(["scratch", "$0070"]);
        });

        it("watches a disassembly operand, or an instruction's address, by its name from a right-click", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            rightClick(code(0x2002).querySelector(".instr_instr_ref"));
            pickFromMenu("Watch dec");
            rightClick(rowAt(0x2002).querySelector(".dis_addr"));
            pickFromMenu("Watch hex");
            dbgr.updateDisassembly(OswrchAt);
            rightClick(rowAt(OswrchAt).querySelector(".dis_addr"));
            pickFromMenu("Watch dec16");
            expect(watchRows().map((row) => [row[0], row[2]])).toEqual([
                ["oswrch", "dec"],
                ["$2002", "hex"],
                ["oswrch", "dec16"],
            ]);
            document.getElementById("watch-close").click();
        });

        it("watches a memory byte by its name, from the hex or the text column", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            goTo("goto-mem-addr-form", "$3000");
            rightClick(memByte(OswrchAt));
            pickFromMenu("Watch hex");
            const text = memByte(OswrchAt).closest("#memory > div").querySelectorAll(".mem_asc span")[0];
            rightClick(text);
            pickFromMenu("Watch dec");
            expect(watchRows().map((row) => [row[0], row[2]])).toEqual([
                ["oswrch", "hex"],
                ["oswrch", "dec"],
            ]);
            document.getElementById("watch-close").click();
        });

        it("leaves the credit as it is while the view moves among the same sets' names", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            const source = symbolsLine().querySelector("a");
            keyPress("j");
            expect(symbolsLine().querySelector("a")).toBe(source);
        });

        it("keeps the credit's line, hidden, while nothing in view is named", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            dbgr.updateDisassembly(0x8000);
            expect(credited()).toBe(false);
            expect(visible("debug-symbols")).toBe(true);
        });

        it("names a clashing global in the address column after the set whose code the CPU is in", async () => {
            const ClockCode = 0x4000;
            const program = (title, start, bytes, globals) => {
                const region = {
                    start: `0x${start.toString(16)}`,
                    end: `0x${(start + 0x10).toString(16)}`,
                    anchors: [{ at: `0x${start.toString(16)}`, bytes }],
                };
                return [
                    { url: `${title}.json`, regions: { code: region } },
                    {
                        ...files.get(`${BaseUrl}mos.json`),
                        title,
                        system: false,
                        globals,
                        regions: { code: { ...region, symbols: {} } },
                    },
                ];
            };
            const [gameEntry, game] = program("game", cpu.pc, "a941", { lives: "0x70" });
            const [clockEntry, clock] = program("clock", ClockCode, "eaea", { ticks: "0x70" });
            [0xea, 0xea].forEach((byte, i) => cpu.writemem(ClockCode + i, byte));
            const programs = new Map([
                [`${BaseUrl}index.json`, { format: 1, sets: [gameEntry, clockEntry] }],
                [`${BaseUrl}game.json`, game],
                [`${BaseUrl}clock.json`, clock],
            ]);
            load.mockImplementation(async (url) => structuredClone(programs.get(url)));
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => {
                dbgr.updateDisassembly(0x70);
                expect(addrOf(rowAt(0x70))).toBe("0070 lives");
            });
            cpu.pc = ClockCode;
            dbgr.updateDisassembly(0x70);
            expect(addrOf(rowAt(0x70))).toBe("0070 ticks");
        });

        describe("with links to the author's site", () => {
            const PlaceUrl = "https://example.com/mos/blob/0123abc/mos.asm#L42";

            beforeEach(() => {
                withMos((mos) => {
                    Object.assign(mos, {
                        home: "https://www.example.com/mos/",
                        nameLink: "https://example.com/mos/blob/0123abc/{place}",
                        places: { oswrch: "mos.asm#L42" },
                    });
                    mos.regions.rom.symbols.unplaced = "0x3004";
                });
            });

            it("links a name in the address column to its place, opening a tab without taking focus", async () => {
                dbgr.debug(OswrchAt);
                await vi.waitFor(() => expect(addrOf(currentRow())).toBe("3000 oswrch"));
                const link = currentRow().querySelector(".dis_addr a.symbol");
                expect(link.href).toBe(PlaceUrl);
                expect(link.target).toBe("_blank");
                expect(link.title).toBe(`oswrch: $3000, from Test MOS\nDefined at ${PlaceUrl}`);
                const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                link.dispatchEvent(press);
                expect(press.defaultPrevented).toBe(true);
            });

            it("keeps a named operand following its address, saying where it's defined", async () => {
                dbgr.debug(cpu.pc);
                await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
                const operand = code(0x2002).querySelector(".instr_instr_ref");
                expect(operand.title).toBe(`oswrch: $3000, from Test MOS\nDefined at ${PlaceUrl}`);
                operand.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                expect(addrOf(currentRow())).toBe("3000 oswrch");
            });

            it("leaves a name with no place unlinked", async () => {
                dbgr.debug(OswrchAt);
                await vi.waitFor(() => expect(addrOf(rowAt(0x3004))).toBe("3004 unplaced"));
                expect(rowAt(0x3004).querySelector(".dis_addr .symbol").tagName).toBe("SPAN");
                expect(rowAt(0x3004).querySelector(".dis_addr .symbol").title).toBe("unplaced: $3004, from Test MOS");
            });

            it("links the author's page, by its site's name, beside the source", async () => {
                dbgr.debug(cpu.pc);
                await vi.waitFor(() => expect(credited()).toBe(true));
                expect(symbolsLine().textContent).toBe("names from Test MOS (example.com, source)");
                expect([...symbolsLine().querySelectorAll("a")].map((a) => a.href)).toEqual([
                    "https://www.example.com/mos/",
                    "https://example.com/mos.lst",
                ]);
            });
        });

        it("checks the anchors again at each stop", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            dbgr.hide();
            cpu.writemem(OswrchAt + 3, 0xea);
            dbgr.debug(cpu.pc);
            expect(code(0x2002).textContent).toBe("JSR $3000");
            expect(credited()).toBe(false);
        });

        it("keeps plain addresses and a working debugger when the index can't be fetched", async () => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            load.mockRejectedValue(new Error("offline"));
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
            expect(code(0x2002).textContent).toBe("JSR $3000");
            expect(credited()).toBe(false);
            keyPress("n");
            expect(addrOf(currentRow())).toBe("2002");
        });

        it("waits for the next stop to look for sets when the index arrives while the machine runs", async () => {
            dbgr.debug(cpu.pc);
            dbgr.hide();
            await vi.waitFor(() => expect(load.mock.settledResults[0]?.type).toBe("fulfilled"));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(load).toHaveBeenCalledTimes(1);
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
        });
    });

    describe("patches", () => {
        it("applies an unconditional patch immediately, each byte of each part", () => {
            dbgr.setPatch("3000:ea4c;3010:60");
            expect([cpu.peekmem(0x3000), cpu.peekmem(0x3001), cpu.peekmem(0x3010)]).toEqual([0xea, 0x4c, 0x60]);
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
