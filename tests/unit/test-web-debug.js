// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Debugger } from "../../src/web/debug.js";
import { fake6502 } from "../../src/fake6502.js";
import { FakeVideo } from "../../src/video.js";
import { SymbolSets } from "../../src/symbol-sets.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

describe("Debugger", () => {
    let cpu;
    let video;
    let dbgr;

    beforeEach(async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        domFromIndexHtml("crtc_debug", "debug", "hardware_debug");
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

        it("stays put and marks the box when the text is neither a name nor an address", () => {
            dbgr.debug(cpu.pc);
            const box = document.querySelector("#goto-dis-addr-form .goto-addr");
            box.value = "monster_x";
            box.form.dispatchEvent(new Event("submit", { cancelable: true }));
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("2000");
            expect(disRows().map((row) => row.querySelector(".dis_addr").textContent)).not.toContain("NaN");
            expect(box.value).toBe("monster_x");
            expect(box.classList.contains("is-invalid")).toBe(true);
            box.dispatchEvent(new Event("input"));
            expect(box.classList.contains("is-invalid")).toBe(false);
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
        const rowAt = (address) => disRows().find((row) => Number(row.dataset.addr) === address);
        const code = (address) => rowAt(address).querySelector(".disassembly");
        const symbolsLine = () => document.getElementById("debug-symbols");

        beforeEach(() => {
            [0x20, 0x00, 0x30, 0x8d, 0x40, 0xfe, 0xb1, 0xf2, 0x6c, 0x0e, 0x02, 0xa5, 0xf2].forEach((byte, i) =>
                cpu.writemem(0x2002 + i, byte),
            );
            [0x6c, 0x0e, 0x02, 0x60, 0xd0, 0xfa].forEach((byte, i) => cpu.writemem(OswrchAt + i, byte));
            load = vi.fn(async (url) => structuredClone(files.get(url)));
            document.body.innerHTML = "";
            domFromIndexHtml("crtc_debug", "debug", "hardware_debug");
            dbgr = new Debugger({ symbolSets: new SymbolSets({ baseUrl: BaseUrl, load }) });
            dbgr.setCpu(cpu);
        });

        it("names operands once the sets that match have arrived, and says where the names came from", async () => {
            dbgr.debug(cpu.pc);
            expect(code(0x2002).textContent).toBe("JSR $3000");
            expect(visible("debug-symbols")).toBe(false);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            expect(code(0x2005).textContent).toBe("STA system_via_register_b");
            expect(code(0x2008).textContent).toMatch(/^LDA \(os_text_ptr\),Y ; \$[0-9a-f]{4} \+ Y$/);
            expect(code(0x200a).textContent).toMatch(/^JMP \(wrchv\) ; \$/);
            expect(code(0x200d).textContent).toBe("LDA os_text_ptr");
            expect(code(0x2000).textContent).toBe("LDA #$41");
            expect(code(0x2002).querySelector(".instr_instr_ref").title).toBe("oswrch: $3000, from Test MOS");
            expect(visible("debug-symbols")).toBe(true);
            expect(symbolsLine().textContent).toBe("names from Test MOS (source)");
            expect(symbolsLine().querySelector(".symbol-set").title).toBe("MIT\n\nCopyright the test");
            expect(symbolsLine().querySelector("a").href).toBe("https://example.com/mos.lst");
        });

        it("names an address in the address column, and still follows a named operand", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            expect(rowAt(0x2002).querySelector(".dis_addr").textContent).toBe("2002");
            code(0x2002)
                .querySelector(".instr_instr_ref")
                .dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("3000 oswrch");
            expect(currentRow().querySelector(".dis_addr .symbol").title).toBe("oswrch: $3000, from Test MOS");
            expect(code(0x3004).textContent).toBe("BNE oswrch");
        });

        it("goes to a name typed in either box, over reading it as hex", async () => {
            load.mockImplementation(async (url) => {
                const json = structuredClone(files.get(url));
                if (url.endsWith("mos.json")) json.regions.rom.symbols.fade = "0x3004";
                return json;
            });
            const goTo = (formId, text) => {
                const form = document.getElementById(formId);
                form.querySelector(".goto-addr").value = text;
                form.dispatchEvent(new Event("submit", { cancelable: true }));
            };
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            goTo("goto-dis-addr-form", " oswrch ");
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("3000 oswrch");
            goTo("goto-dis-addr-form", "fade");
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("3004 fade");
            goTo("goto-dis-addr-form", "$fade");
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("fade");
            goTo("goto-mem-addr-form", "os_text_ptr");
            expect(memHighlight().querySelector(".dis_addr").textContent).toBe("00f2");
        });

        it("still follows a named zero-page operand to the memory view", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x200d).textContent).toBe("LDA os_text_ptr"));
            code(0x200d)
                .querySelector(".instr_mem_ref")
                .dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(memHighlight().querySelector(".dis_addr").textContent).toBe("00f2");
        });

        it("shows a source that isn't https as text, not a link", async () => {
            load.mockImplementation(async (url) => {
                const json = structuredClone(files.get(url));
                if (url.endsWith("mos.json")) json.source = "javascript:alert(1)";
                return json;
            });
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(visible("debug-symbols")).toBe(true));
            expect(symbolsLine().textContent).toBe("names from Test MOS (javascript:alert(1))");
            expect(symbolsLine().querySelector("a")).toBeNull();
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
            await vi.waitFor(() => expect(symbolsLine().querySelectorAll(".symbol-set")).toHaveLength(2));
            dbgr.updateDisassembly(0x70);
            expect(rowAt(0x70).querySelector(".dis_addr").textContent).toBe("0070 lives");
            cpu.pc = ClockCode;
            dbgr.updateDisassembly(0x70);
            expect(rowAt(0x70).querySelector(".dis_addr").textContent).toBe("0070 ticks");
        });

        describe("with links to the author's site", () => {
            const PlaceUrl = "https://example.com/mos/blob/0123abc/mos.asm#L42";

            beforeEach(() => {
                load.mockImplementation(async (url) => {
                    const json = structuredClone(files.get(url));
                    if (url.endsWith("mos.json")) {
                        Object.assign(json, {
                            home: "https://www.example.com/mos/",
                            nameLink: "https://example.com/mos/blob/0123abc/{place}",
                            places: { oswrch: "mos.asm#L42" },
                        });
                        json.regions.rom.symbols.unplaced = "0x3004";
                    }
                    return json;
                });
            });

            it("links a name in the address column to its place, opening a tab without taking focus", async () => {
                dbgr.debug(OswrchAt);
                await vi.waitFor(() => expect(currentRow().querySelector(".dis_addr").textContent).toBe("3000 oswrch"));
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
                expect(currentRow().querySelector(".dis_addr").textContent).toBe("3000 oswrch");
            });

            it("leaves a name with no place unlinked", async () => {
                dbgr.debug(OswrchAt);
                await vi.waitFor(() =>
                    expect(rowAt(0x3004).querySelector(".dis_addr").textContent).toBe("3004 unplaced"),
                );
                expect(rowAt(0x3004).querySelector(".dis_addr .symbol").tagName).toBe("SPAN");
                expect(rowAt(0x3004).querySelector(".dis_addr .symbol").title).toBe("unplaced: $3004, from Test MOS");
            });

            it("shows a home that isn't https as no link", async () => {
                load.mockImplementation(async (url) => {
                    const json = structuredClone(files.get(url));
                    if (url.endsWith("mos.json")) json.home = "javascript:alert(1)";
                    return json;
                });
                dbgr.debug(cpu.pc);
                await vi.waitFor(() => expect(visible("debug-symbols")).toBe(true));
                expect(symbolsLine().textContent).toBe("names from Test MOS (source)");
            });

            it("links the author's page, by its site's name, beside the source", async () => {
                dbgr.debug(cpu.pc);
                await vi.waitFor(() => expect(visible("debug-symbols")).toBe(true));
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
            expect(visible("debug-symbols")).toBe(false);
        });

        it("keeps plain addresses and a working debugger when the index can't be fetched", async () => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            load.mockRejectedValue(new Error("offline"));
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
            expect(code(0x2002).textContent).toBe("JSR $3000");
            expect(visible("debug-symbols")).toBe(false);
            keyPress("n");
            expect(currentRow().querySelector(".dis_addr").textContent).toBe("2002");
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
