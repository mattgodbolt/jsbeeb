// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Debugger, ToolbarKeys } from "../../src/web/debug.js";
import { DisassemblyKeys } from "../../src/web/disassembly-view.js";
import { Gap } from "../../src/web/panel-layout.js";
import { RunMode } from "../../src/web/emulation-loop.js";
import { fake6502 } from "../../src/fake6502.js";
import { findModel, TEST_65C12 } from "../../src/models.js";
import { FakeVideo } from "../../src/video.js";
import { hexbyte, hexword } from "../../src/hex.js";
import { SymbolSets } from "../../src/symbol-sets.js";
import { PanelKeys } from "../../src/web/panel-keys.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { SysViaPanel } from "../../src/web/sysvia-panel.js";
import { cycleCount } from "../../src/lockstep.js";
import { domFromIndexHtml, fakeAnimationFrames, sentEvents, stubResizeObserver, teardownDom } from "./helpers.js";

const PanelElements = [
    "toolbar-panel",
    "disassembly-panel",
    "memory-panel",
    "registers-panel",
    "watch-panel",
    "watch-menu",
    "cub-monitor",
];

const MachineSecond = 2000000;

/** Runs and stops as the emulation loop does, a tick at a time; it starts in the debugger. */
class StandInLoop extends EventTarget {
    constructor(dbgr, cpu) {
        super();
        this.dbgr = dbgr;
        this.cpu = cpu;
        this.mode = RunMode.debugging;
        this.running = false;
        this.lockstep = null;
        this.clocksPerSecond = MachineSecond;
    }
    isRunning() {
        return this.running;
    }
    go() {
        this.mode = RunMode.running;
        this.dbgr.hide();
        this.running = true;
    }
    stop(debug) {
        this.mode = debug ? RunMode.debugging : RunMode.paused;
        this.running = false;
        if (debug) this.dbgr.debug(this.cpu.pc);
        else this.dbgr.hide();
    }
    tick(cycles) {
        if (this.cpu.execute(cycles)) return;
        this.mode = RunMode.debugging;
        this.running = false;
        this.dbgr.debug(this.cpu.pc);
    }
}

describe("Debugger", () => {
    let cpu;
    let video;
    let dbgr;
    let keys;
    let arrangement;
    let stoppedLoop;
    let resize;
    const monitor = () => document.getElementById("cub-monitor");

    /** A debugger on a fresh page, with a loop that puts the machine in it when stopped. */
    const makeDebugger = (symbolSets) => {
        arrangement = new PanelArrangement(() => window.localStorage);
        arrangement.followMachine(() => cycleCount(cpu));
        keys = new PanelKeys(arrangement);
        const made = new Debugger({ symbolSets, keys, arrangement, monitor: monitor() });
        made.setCpu(cpu);
        stoppedLoop = new StandInLoop(made, cpu);
        made.attachLoop(stoppedLoop);
        return made;
    };

    beforeEach(async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        window.localStorage.clear();
        domFromIndexHtml(...PanelElements);
        resize = stubResizeObserver();
        video = new FakeVideo();
        video.debugPaint = vi.fn();
        cpu = fake6502(null, { video });
        await cpu.initialise();
        cpu.writemem(0x2000, 0xa9);
        cpu.writemem(0x2001, 0x41);
        cpu.pc = 0x2000;
        dbgr = makeDebugger(null);
    });

    afterEach(() => {
        // Closed, they stop looking at the machine once a frame.
        dbgr.hidePanels();
        return teardownDom();
    });

    const visible = (id) => !document.getElementById(id).hidden;
    const disRows = () => [...document.querySelectorAll("#disassembly .dis_elem:not(.template)")];
    const currentRow = () => document.querySelector("#disassembly .highlight");
    const memHighlight = () => document.querySelector("#memory .highlight");
    const memTarget = () => document.querySelector("#memory .mem_bytes .target");
    /** A key as the page hands it on while the machine is stopped. */
    const keyPress = (char) => keys.press(char);
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
        it("centres the disassembly on what it moves to at any height, and keeps a stopped one's row through a resize", () => {
            const rowHeight = 16;
            const highlightRow = () => disRows().indexOf(currentRow());
            const resizeTo = (rows) => resize(document.getElementById("disassembly"), rows * rowHeight);
            dbgr.showPanels();
            goTo("goto-dis-addr-form", "c000");
            vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 0, rowHeight));
            resizeTo(40);
            expect(disRows()).toHaveLength(40);
            expect([addrOf(currentRow()), highlightRow()]).toEqual(["c000", 8]);

            dbgr.debug(cpu.pc);
            expect(highlightRow()).toBe(20);
            resizeTo(16);
            expect(highlightRow()).toBe(8);
            resizeTo(40);
            keyPress("j");
            expect(highlightRow()).toBe(20);
            resizeTo(50);
            keyPress("t");
            expect(highlightRow()).toBe(20);
            dbgr.panels.disassembly.close();
            dbgr.panels.disassembly.open();
            expect(highlightRow()).toBe(20);

            stoppedLoop.go();
            resizeTo(30);
            expect([addrOf(currentRow()), highlightRow()]).toEqual([hexword(cpu.pc), 15]);
        });

        const DebugPanels = ["toolbar-panel", "disassembly-panel", "registers-panel", "memory-panel"];
        const shown = () => DebugPanels.filter(visible);

        it("open on entering the debugger, and stay open once the machine goes on", () => {
            expect(shown()).toEqual([]);
            dbgr.debug(cpu.pc);
            expect(dbgr.inDebugger()).toBe(true);
            expect(shown()).toEqual(DebugPanels);
            stoppedLoop.go();
            expect(dbgr.inDebugger()).toBe(false);
            expect(shown()).toEqual(DebugPanels);
        });

        it("stay shut on entering the debugger while the on-screen keyboard shows, at any width, but show when asked", () => {
            let keyboardShown = true;
            dbgr.keepOffTouchKeyboard(() => keyboardShown);
            dbgr.debug(cpu.pc);
            expect(dbgr.inDebugger()).toBe(true);
            expect(shown()).toEqual([]);
            dbgr.togglePanels();
            expect(shown()).toEqual(DebugPanels);
            dbgr.toggleDebugger();
            keyboardShown = false;
            dbgr.toggleDebugger();
            expect(shown()).toEqual(DebugPanels);
        });

        it("close on leaving the debugger by its toggle, and the same ones open on entering it again", () => {
            dbgr.debug(cpu.pc);
            dbgr.panels.memory.close();
            dbgr.toggleDebugger();
            expect(stoppedLoop.mode).toBe(RunMode.running);
            expect(shown()).toEqual([]);
            dbgr.toggleDebugger();
            expect(stoppedLoop.mode).toBe(RunMode.debugging);
            expect(shown()).toEqual(["toolbar-panel", "disassembly-panel", "registers-panel"]);
        });

        it("open the defaults again once every one has been closed by hand", () => {
            dbgr.debug(cpu.pc);
            for (const floating of Object.values(dbgr.panels)) floating.close();
            dbgr.toggleDebugger();
            dbgr.toggleDebugger();
            expect(shown()).toEqual(DebugPanels);
        });

        it("show and hide on their own toggle, leaving the machine running or stopped as it was", () => {
            stoppedLoop.mode = RunMode.running;
            dbgr.togglePanels();
            expect(shown()).toEqual(DebugPanels);
            expect(stoppedLoop.mode).toBe(RunMode.running);
            expect(dbgr.inDebugger()).toBe(false);
            expect(addrOf(currentRow())).toBe("2000");
            dbgr.togglePanels();
            expect(shown()).toEqual([]);
            expect(stoppedLoop.mode).toBe(RunMode.running);
        });

        it("are listed for a menu of panels by their titles, with the watches", () => {
            expect(arrangement.listed().map((floating) => floating.title)).toEqual([
                "Watches",
                "Debugger toolbar",
                "Disassembly",
                "Memory",
                "Registers",
            ]);
        });

        it("bring the toolbar with them, whatever else was open last", () => {
            stoppedLoop.mode = RunMode.running;
            dbgr.panels.registers.open();
            dbgr.panels.registers.close();
            dbgr.panels.registers.open();
            dbgr.hidePanels();
            dbgr.toggleDebugger();
            expect(shown()).toEqual(["toolbar-panel", "registers-panel"]);
        });

        it("count every panel made in the debug group among them, such as a decoded device's, hiding it and showing it again with the rest", () => {
            const sysvia = new SysViaPanel({ cpu, arrangement });
            dbgr.togglePanels();
            sysvia.floating.open();
            dbgr.togglePanels();
            expect(visible("sysvia-panel")).toBe(false);
            dbgr.togglePanels();
            expect(visible("sysvia-panel")).toBe(true);
            expect(shown()).toEqual(DebugPanels);
        });

        it("leave out a panel that was open last but this machine has none of, as a system VIA on an Atom", () => {
            const sysvia = new SysViaPanel({ cpu, arrangement });
            dbgr.togglePanels();
            sysvia.floating.open();
            dbgr.togglePanels();
            dbgr.hidePanels();
            document.body.innerHTML = "";
            domFromIndexHtml(...PanelElements);
            dbgr = makeDebugger(null);
            dbgr.togglePanels();
            expect(shown()).toEqual(DebugPanels);
        });

        it("remember which were open only as one of them opens or closes, not as another panel does", () => {
            dbgr.togglePanels();
            dbgr.panels.memory.close();
            dbgr.hidePanels();
            dbgr.watches.floating.open();
            dbgr.togglePanels();
            expect(shown()).toEqual(["toolbar-panel", "disassembly-panel", "registers-panel"]);
        });

        describe("in their default places", () => {
            const gutters = (left, right) => dbgr.placeBesideScreen(() => ({ left, right: window.innerWidth - right }));

            it("take the width of a gutter wide enough for a column, and their natural width beside a narrower one, the disassembly's side needing more", () => {
                gutters(300, 400);
                expect(dbgr.panels.memory.place().w).toBe(300 - Gap);
                expect(dbgr.panels.disassembly.place().w).toBe(null);
                gutters(250, 420);
                expect(dbgr.panels.memory.place().w).toBe(null);
                expect(dbgr.panels.disassembly.place().w).toBe(420 - Gap);
            });

            it("are worked out afresh for the window as it is each time they are laid out", () => {
                dbgr.placeBesideScreen(() => ({ left: 300, right: 424 }));
                expect(dbgr.panels.registers.place().w).toBe(1024 - 424 - Gap);
                vi.spyOn(window, "innerWidth", "get").mockReturnValue(1200);
                expect(dbgr.panels.registers.place().w).toBe(1200 - 424 - Gap);
            });

            it("stack under one another down each side", () => {
                expect(dbgr.panels.registers.place().y.attach).toEqual({ to: "disassembly", side: "after" });
                expect(dbgr.panels.disassembly.place().y.attach).toEqual({ to: "toolbar", side: "after" });
            });
        });

        it("show the stack from its top and the cycles run", () => {
            cpu.s = 0xfc;
            cpu.writemem(0x1fd, 0x12);
            cpu.writemem(0x1fe, 0x34);
            cpu.writemem(0x1ff, 0x56);
            dbgr.debug(cpu.pc);
            expect(document.getElementById("cpu6502_stack").textContent).toBe("12 34 56");
            expect(Number(document.getElementById("cpu6502_cycles").textContent)).toBe(
                cpu.cycleSeconds * cpu.model.cyclesPerSecond + cpu.currentCycles,
            );
            cpu.s = 0xff;
            dbgr.debug(cpu.pc);
            expect(document.getElementById("cpu6502_stack").textContent).toBe("");
        });

        it("time from where the stopwatch was reset, until the state it was reset in is replaced, through a power-on reset", () => {
            const stopwatch = () => document.getElementById("debug-stopwatch").textContent;
            const reset = () => document.getElementById("debug-stopwatch-reset").click();
            dbgr.debug(cpu.pc);
            expect(stopwatch()).toBe(String(cpu.scheduler.epoch));
            reset();
            expect(stopwatch()).toBe("0");
            keyPress("n");
            expect(stopwatch()).toBe("2");
            dbgr.replacingState();
            dbgr.debug(cpu.pc);
            expect(stopwatch()).toBe("");
            reset();
            keyPress("n");
            const timed = stopwatch();
            cpu.reset(true);
            dbgr.debug(cpu.pc);
            expect(stopwatch()).toBe(timed);
            expect(cycleCount(cpu)).toBe(0);
        });

        it("show where the beam is in the frame, and the CRTC's counters only on a machine with one", () => {
            const text = (id) => document.getElementById(id).textContent;
            cpu.execute(1000);
            dbgr.debug(cpu.pc);
            const beam = video.beamPosition();
            expect([text("beam-line"), text("beam-cycle")]).toEqual([String(beam.line), String(beam.frameCycle)]);
            expect(visible("beam-crtc")).toBe(false);
            video.beamPosition = () => ({ ...beam, crtc: { row: 5, scanline: 3, column: 40 } });
            dbgr.debug(cpu.pc);
            expect(visible("beam-crtc")).toBe(true);
            expect([text("crtc-row"), text("crtc-scanline"), text("crtc-column")]).toEqual(["5", "3", "40"]);
        });

        it("give the keyboard back on Escape in a goto box, staying open", () => {
            dbgr.debug(cpu.pc);
            const box = document.querySelector("#goto-dis-addr-form .goto-addr");
            box.focus();
            box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            expect(document.activeElement).not.toBe(box);
            expect(visible("disassembly-panel")).toBe(true);
        });

        describe("once a frame", () => {
            let frames;
            const shownA = () => document.getElementById("cpu6502_a").textContent;

            beforeEach(() => {
                frames = fakeAnimationFrames();
                dbgr.debug(cpu.pc);
            });

            it("keep up with the machine as it runs, following the program counter, without side effects", () => {
                stoppedLoop.go();
                cpu.writemem(0x0000, 0x77);
                stoppedLoop.tick(2);
                const read = vi.spyOn(cpu, "readmem");
                frames.run();
                expect(shownA()).toBe("41");
                expect(addrOf(document.querySelector("#disassembly .current"))).toBe("2002");
                expect(memHighlight().querySelector(".mem_bytes span").textContent).toBe("77");
                expect(read).not.toHaveBeenCalled();
            });

            it("draw nothing while the machine stands still, so a click lands on what it went down on", () => {
                const operand = () => disRows()[8].querySelector(".disassembly").firstChild;
                const before = operand();
                const peek = vi.spyOn(cpu, "peekmem");
                frames.run();
                frames.run();
                expect(peek).not.toHaveBeenCalled();
                expect(operand()).toBe(before);
            });

            it("read nothing once closed", () => {
                stoppedLoop.go();
                dbgr.hidePanels();
                expect(frames.pending).toBe(0);
                const peek = vi.spyOn(cpu, "peekmem");
                stoppedLoop.tick(2);
                frames.run();
                expect(peek).not.toHaveBeenCalled();
            });
        });

        describe("the toolbar", () => {
            const button = (run) => document.querySelector(`#toolbar-panel [data-run="${run}"]`);
            const enabled = () =>
                ["go", "stop", "step", "stepOver", "stepOut", "runToCursor", "runToVsync"].filter(
                    (run) => !button(run).disabled,
                );

            it("offers what the machine can do as it is", () => {
                expect(enabled()).toEqual(["go", "step", "stepOver", "stepOut", "runToCursor", "runToVsync"]);
                stoppedLoop.running = true;
                stoppedLoop.dispatchEvent(new Event("running"));
                expect(enabled()).toEqual(["stop"]);
            });

            it("names in each button's tooltip the key that does the same", () => {
                const keyFor = (run) =>
                    [...ToolbarKeys, ...DisassemblyKeys].find((row) => row.run === run && row.key).key;
                for (const run of ["go", "step", "stepOver", "stepOut", "runToCursor", "runToVsync"])
                    expect(button(run).title).toMatch(new RegExp(`\\(${keyFor(run)}\\)$`));
            });

            it("steps from a pause by entering the debugger first", () => {
                stoppedLoop.mode = RunMode.paused;
                button("step").click();
                expect(stoppedLoop.mode).toBe(RunMode.debugging);
                expect(document.getElementById("cpu6502_pc").textContent).toBe("2002");
            });

            it("keeps its buttons from focus", () => {
                const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                button("step").dispatchEvent(press);
                expect(press.defaultPrevented).toBe(true);
            });
        });

        it("note the debugger opening each time it is entered, not each time it stops, and each panel as it opens", () => {
            const sent = sentEvents();
            dbgr.debug(cpu.pc);
            dbgr.debug(cpu.pc);
            dbgr.hide();
            dbgr.debug(cpu.pc);
            expect(sent("feature_used")).toEqual([
                { feature: "debugger", action: "open" },
                { feature: "debug_toolbar", action: "open" },
                { feature: "debug_disassembly", action: "open" },
                { feature: "debug_registers", action: "open" },
                { feature: "debug_memory", action: "open" },
                { feature: "debugger", action: "open" },
            ]);
        });

        it("wait for the machine before drawing when the symbol index arrives first", async () => {
            const index = { load: vi.fn(async () => ({ format: 1, sets: [] })) };
            dbgr.hidePanels();
            document.body.innerHTML = "";
            domFromIndexHtml(...PanelElements);
            arrangement = new PanelArrangement(() => window.localStorage);
            const symbolSets = new SymbolSets({ baseUrl: new URL("https://symbols.example/"), load: index.load });
            dbgr = new Debugger({ symbolSets, keys: new PanelKeys(arrangement), arrangement, monitor: monitor() });
            dbgr.watches.floating.open();
            dbgr.panels.registers.open();
            await vi.waitFor(() => expect(index.load).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 0));
            dbgr.setCpu(cpu);
            expect(document.getElementById("cpu6502_pc").textContent).toBe("2000");
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

    it("centres the disassembly on the program counter on entering the debugger, and repaints the screen", () => {
        dbgr.debug(cpu.pc);
        const row = currentRow();
        expect(row.classList.contains("current")).toBe(true);
        expect(addrOf(row)).toBe("2000");
        expect(video.debugPaint).toHaveBeenCalled();
    });

    describe("the memory window", () => {
        it("shows the bytes and text around the address the form asks for, marked in its aligned row", () => {
            cpu.writemem(0x1234, 0x48);
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$1234");
            const row = memHighlight();
            expect(row.querySelector(".dis_addr").textContent).toBe("1230");
            const marked = [...row.querySelectorAll(".target")];
            expect(marked.map((span) => span.textContent)).toEqual(["48", "H"]);
            expect(row.querySelector(".mem_bytes").textContent).toMatch(/^[0-9a-f]{2}( [0-9a-f]{2}){7}$/);
        });

        it("leaves the memory view alone when the text is neither a name nor an address", () => {
            dbgr.debug(cpu.pc);
            goTo("goto-mem-addr-form", "$1234");
            goTo("goto-mem-addr-form", "monster_x");
            const box = document.querySelector("#goto-mem-addr-form .goto-addr");
            expect(addrOf(memHighlight())).toBe("1230");
            expect(box.classList.contains("is-invalid")).toBe(true);
        });

        it("marks bytes changed since the last debugger visit, forgetting them on leaving", () => {
            const gotoMem = (value) => goTo("goto-mem-addr-form", value);
            const changed = () => memTarget().classList.contains("changed");
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
            expect(memTarget().textContent).toBe(hexbyte(cpu.peekmem(SysViaOra)));
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
            goTo("goto-mem-addr-form", "$0004");
            keyPress("i");
            expect(memTarget().dataset.addr).toBe(`${0xfffc}`);
        });

        it("opens on the byte drawn where the stopped screen is clicked, and leaves a running one's clicks alone", () => {
            const picture = vi.spyOn(video, "addressShownAt").mockImplementation((x, y) => (y < 0.5 ? 0x3456 : null));
            const findsBytes = () => monitor().classList.contains("finds-bytes");
            dbgr.debug(cpu.pc);
            dbgr.panels.memory.close();
            expect(findsBytes()).toBe(true);

            expect(dbgr.showScreenByteAt(0.25, 0.75)).toBe(true);
            expect(visible("memory-panel")).toBe(false);
            expect(dbgr.showScreenByteAt(0.25, 0.25)).toBe(true);
            expect(picture).toHaveBeenLastCalledWith(0.25, 0.25);
            expect(visible("memory-panel")).toBe(true);
            expect(memTarget().dataset.addr).toBe(`${0x3456}`);

            dbgr.keepOffTouchKeyboard(() => true);
            expect(dbgr.showScreenByteAt(0.25, 0.25)).toBe(false);
            dbgr.keepOffTouchKeyboard(() => false);

            stoppedLoop.go();
            expect(findsBytes()).toBe(false);
            expect(dbgr.showScreenByteAt(0.25, 0.25)).toBe(false);
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

        it("moves the CPU's cycle target on by one on N, running an instruction only once it is passed", () => {
            dbgr.debug(cpu.pc);
            keyPress("n");
            const pc = () => document.getElementById("cpu6502_pc").textContent;
            expect(pc()).toBe("2002");
            const steps = [];
            for (let i = 0; i < 3; i++) {
                keyPress("N");
                steps.push(pc());
            }
            expect(steps).toContain("2002");
            expect(steps.some((at) => at !== "2002")).toBe(true);
        });

        it("keeps the run and step keys for the debugger, and the panels' own for whenever it is stopped", () => {
            dbgr.debug(cpu.pc);
            stoppedLoop.mode = RunMode.paused;
            expect(keyPress("n")).toBe(false);
            expect(keyPress("j")).toBe(true);
            expect(addrOf(currentRow())).toBe("2002");
        });

        it("keeps a panel's keys to it while it is open, but the run and step keys to the debugger, toolbar or not", () => {
            dbgr.debug(cpu.pc);
            dbgr.panels.memory.close();
            expect(keyPress("u")).toBe(false);
            dbgr.panels.toolbar.close();
            expect(keyPress("n")).toBe(true);
            expect(document.getElementById("cpu6502_pc").textContent).toBe("2002");
        });
    });

    describe("stepping", () => {
        const load = (address, bytes) => bytes.forEach((byte, i) => cpu.writemem(address + i, byte));
        const pc = () => document.getElementById("cpu6502_pc").textContent;
        // LDX #3; DEX; BNE $2002; LDA #$41
        const countdown = [0xa2, 0x03, 0xca, 0xd0, 0xfd, 0xa9, 0x41];
        let loop;

        /** Runs and stops as the emulation loop does, a tick at a time. */
        beforeEach(() => {
            loop = stoppedLoop;
        });

        it("runs to the cursor from a pause by entering the debugger first", () => {
            dbgr.debug(cpu.pc);
            loop.mode = RunMode.paused;
            keyPress("j");
            keyPress("c");
            expect(loop.mode).toBe(RunMode.debugging);
            expect(pc()).toBe("2002");
        });

        it("steps one instruction on n even when it goes nowhere", () => {
            load(0x2000, [0x4c, 0x00, 0x20]);
            dbgr.debug(cpu.pc);
            const before = cpu.currentCycles;
            keyPress("n");
            expect(pc()).toBe("2000");
            expect(cpu.currentCycles - before).toBe(3);
        });

        it("steps over a loop that leaves backwards", () => {
            // NOP; LDX #3; DEX; BEQ $2000; BNE $2003
            load(0x2000, [0xea, 0xa2, 0x03, 0xca, 0xf0, 0xfa, 0xd0, 0xfb]);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$2006");
            keyPress("c");
            keyPress("m");
            expect(pc()).toBe("2000");
            expect(loop.running).toBe(false);
        });

        it("steps over a loop that makes a call with the stack about to wrap", () => {
            // LDX #1; TXS; LDX #3; JSR $3000; DEX; BNE $2005; NOP, with an RTS at $3000
            load(0x2000, [0xa2, 0x01, 0x9a, 0xa2, 0x03, 0x20, 0x00, 0x30, 0xca, 0xd0, 0xfa, 0xea]);
            load(0x3000, [0x60]);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$2009");
            keyPress("c");
            keyPress("m");
            expect(pc()).toBe("200b");
            expect(cpu.x).toBe(0);
        });

        it("steps over onto the reset entry", () => {
            const entry = dbgr.resetEntry();
            load(entry - 1, [0xea]);
            cpu.pc = entry - 1;
            dbgr.debug(cpu.pc);
            keyPress("m");
            expect(pc()).toBe(hexword(entry));
        });

        it("leaves a step over a call into the reset entry to the reset", () => {
            const entry = dbgr.resetEntry();
            load(0x2100, [0x20, entry & 0xff, entry >> 8, 0xea]);
            cpu.pc = 0x2100;
            dbgr.debug(cpu.pc);
            keyPress("m");
            expect(cpu.onFastPath).toBe(true);
        });

        it("ends a step over whose return is the reset entry when a reset comes first", () => {
            load(0xfffc, [0x00, 0x40]);
            load(0x3ffd, [0x20, 0x00, 0x30]);
            load(0x3000, [0x4c, 0x00, 0x30]);
            cpu.pc = 0x3ffd;
            dbgr.debug(cpu.pc);
            keyPress("m");
            expect(loop.running).toBe(true);
            cpu.reset(false);
            loop.tick(MachineSecond);
            expect(loop.running).toBe(true);
            expect(cpu.onFastPath).toBe(true);
        });

        it("steps out past the returns of the calls it makes", () => {
            load(0x2000, [0x20, 0x00, 0x30]);
            load(0x3000, [0x20, 0x00, 0x31, 0x60]);
            load(0x3100, [0x60]);
            dbgr.debug(cpu.pc);
            keyPress("n");
            keyPress("o");
            expect(pc()).toBe("2003");
        });

        it("steps over a 65C12 loop closed by BRA to wherever it leaves by", async () => {
            cpu = fake6502(TEST_65C12, { video });
            await cpu.initialise();
            cpu.pc = 0x2000;
            dbgr.setCpu(cpu);
            // LDX #3; DEX; BEQ $2008; BRA $2002; NOP; NOP
            load(0x2000, [0xa2, 0x03, 0xca, 0xf0, 0x03, 0x80, 0xfb, 0xea, 0xea]);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$2005");
            keyPress("c");
            keyPress("m");
            expect(pc()).toBe("2008");
        });

        it("stops a run at a write watch on its first instruction", () => {
            // STA $70; NOP; NOP
            load(0x2000, [0x85, 0x70, 0xea, 0xea]);
            cpu.debugWrite.add((address) => address === 0x70);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$2003");
            keyPress("c");
            expect(pc()).toBe("2002");
        });

        it("steps over a forward branch to where it went", () => {
            // LDA #0; BEQ $2006; NOP; NOP; NOP
            load(0x2000, [0xa9, 0x00, 0xf0, 0x02, 0xea, 0xea, 0xea]);
            dbgr.debug(cpu.pc);
            keyPress("n");
            keyPress("m");
            expect(pc()).toBe("2006");
        });

        it("stops a step over at a breakpoint inside the call, and steps out from it", () => {
            load(0x2000, [0x20, 0x00, 0x30]);
            load(0x3000, [0xea, 0x60]);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$3000");
            keyPress("t");
            keyPress("m");
            expect(pc()).toBe("3000");
            keyPress("o");
            expect(pc()).toBe("2003");
        });

        describe("past a fiftieth of a second", () => {
            // Four times round 256 * 256 DEX/BNE, then NOP at $200E: about 1.3 million cycles.
            const long = [0xa0, 0x00, 0xa2, 0x00, 0xca, 0xd0, 0xfd, 0x88, 0xd0, 0xf8, 0xc6, 0x70, 0xd0, 0xf2, 0xea];

            beforeEach(() => {
                load(0x2000, long);
                cpu.writemem(0x70, 4);
                dbgr.debug(cpu.pc);
                goTo("goto-dis-addr-form", "$200E");
            });

            it("runs the machine to the cursor, stopping there however long it takes", () => {
                keyPress("c");
                expect(loop.running).toBe(true);
                loop.tick(MachineSecond);
                expect(loop.running).toBe(false);
                expect(pc()).toBe("200e");
            });

            it("steps over a call that runs for longer, stopping where it returns", () => {
                load(0x200e, [0x60]);
                load(0x3000, [0x20, 0x00, 0x20, 0xea]);
                cpu.pc = 0x3000;
                dbgr.debug(cpu.pc);
                keyPress("m");
                expect(loop.running).toBe(true);
                loop.tick(MachineSecond);
                expect(pc()).toBe("3003");
            });

            it("shows what the whole run changed in memory, from its very start", () => {
                // LDA #$41; STA $60; JMP $2000
                load(0x2100, [0xa9, 0x41, 0x85, 0x60, 0x4c, 0x00, 0x20]);
                cpu.pc = 0x2100;
                dbgr.debug(cpu.pc);
                goTo("goto-dis-addr-form", "$200E");
                keyPress("c");
                loop.tick(MachineSecond);
                expect(pc()).toBe("200e");
                expect(memByte(0x60).classList.contains("changed")).toBe(true);
            });

            it("waits with no limit for a cursor the machine does not reach", () => {
                goTo("goto-dis-addr-form", "$3000");
                keyPress("c");
                for (let i = 0; i < 10; i++) loop.tick(MachineSecond);
                expect(loop.running).toBe(true);
            });

            it("hands all but the first instruction to the loop in a shared session", () => {
                loop.lockstep = {};
                keyPress("c");
                expect(cpu.pc).toBe(0x2002);
                expect(loop.running).toBe(true);
                loop.tick(MachineSecond);
                expect(pc()).toBe("200e");
            });

            it("stops at a cursor on the reset entry when the machine is reset", () => {
                const entry = dbgr.resetEntry();
                goTo("goto-dis-addr-form", `$${hexword(entry)}`);
                keyPress("c");
                cpu.reset(false);
                loop.tick(MachineSecond);
                expect(cpu.pc).toBe(entry);
                expect(loop.running).toBe(false);
            });

            describe("forgets where it was going", () => {
                // Runs on to the cursor at $200E once nothing stops it there.
                const reachesCursor = () => {
                    cpu.targetCycles = cpu.currentCycles;
                    return cpu.execute(MachineSecond);
                };

                it("when the machine is paused", () => {
                    keyPress("c");
                    loop.stop(false);
                    expect(reachesCursor()).toBe(true);
                });

                it("when the quick run throws", () => {
                    const failure = cpu.debugInstruction.add((at) => {
                        if (at === 0x2002) throw new Error("emulation failed");
                        return false;
                    });
                    expect(() => keyPress("c")).toThrow("emulation failed");
                    expect(pc()).toBe("2002");
                    failure.remove();
                    expect(reachesCursor()).toBe(true);
                });

                it("when the debugger is entered some other way", () => {
                    keyPress("c");
                    dbgr.debug(cpu.pc);
                    expect(reachesCursor()).toBe(true);
                });

                it("when the machine is reset", () => {
                    keyPress("c");
                    cpu.reset(false);
                    cpu.execute(100);
                    expect(cpu.onFastPath).toBe(true);
                });
            });
        });

        describe("to a place in the frame", () => {
            const LongestInstruction = 7;
            const beam = () => video.beamPosition();
            // Whether it ends in the debugger's quick run or the loop's, depends on how far the target is.
            const finishRun = () => {
                if (loop.running) loop.tick(MachineSecond);
            };

            beforeEach(() => {
                // JMP $2000
                load(0x2000, [0x4c, 0x00, 0x20]);
                dbgr.debug(cpu.pc);
            });

            it("runs to the start of the next vsync, from in one as from out of one", () => {
                for (let i = 0; i < 2; i++) {
                    keyPress("v");
                    finishRun();
                    expect(loop.running).toBe(false);
                    expect(beam().inVSync).toBe(true);
                    expect(beam().frameCycle).toBeLessThan(LongestInstruction);
                }
            });

            it("runs to the start of a line, the next frame's when the beam is on it", () => {
                const lineCycles = 128;
                const fieldCycles = 312.5 * lineCycles;
                goTo("run-to-line-form", "100");
                finishRun();
                expect(beam().line).toBe(100);
                expect(beam().frameCycle - 100 * lineCycles).toBeLessThan(LongestInstruction);
                const arrived = cycleCount(cpu);
                goTo("run-to-line-form", "100");
                finishRun();
                expect(beam().line).toBe(100);
                expect(cycleCount(cpu) - arrived).toBeGreaterThan(fieldCycles - LongestInstruction);
            });

            it("takes only a whole number for a line", () => {
                goTo("run-to-line-form", "1e2");
                expect(document.querySelector("#run-to-line-form .goto-addr").classList.contains("is-invalid")).toBe(
                    true,
                );
                expect(cpu.pc).toBe(0x2000);
            });

            it("forgets the run when the machine's state is replaced", () => {
                goTo("run-to-line-form", "400");
                expect(loop.running).toBe(true);
                dbgr.replacingState();
                expect(cpu.onFastPath).toBe(true);
            });
        });

        it("steps over a loop that makes a call", () => {
            // LDX #3; JSR $3000; DEX; BNE $2002; NOP, with an RTS at $3000
            load(0x2000, [0xa2, 0x03, 0x20, 0x00, 0x30, 0xca, 0xd0, 0xfa, 0xea]);
            load(0x3000, [0x60]);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$2006");
            keyPress("c");
            keyPress("m");
            expect(pc()).toBe("2008");
            expect(cpu.x).toBe(0);
        });

        it("steps over a recursive call to where it returns at the same depth", () => {
            // $3000: DEC $70; BEQ $3007; JSR $3000; RTS
            load(0x2000, [0x20, 0x00, 0x30]);
            load(0x3000, [0xc6, 0x70, 0xf0, 0x03, 0x20, 0x00, 0x30, 0x60]);
            cpu.writemem(0x70, 3);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$3004");
            keyPress("c");
            const depth = cpu.s;
            keyPress("m");
            expect(pc()).toBe("3007");
            expect(cpu.s).toBe(depth);
        });

        it("steps over a BRK into its handler", () => {
            const vector = cpu.peekmem(0xfffe) | (cpu.peekmem(0xffff) << 8);
            load(0x2000, [0x00]);
            dbgr.debug(cpu.pc);
            keyPress("m");
            expect(pc()).toBe(hexword(vector));
        });

        it("runs right round to a breakpoint on the current instruction", () => {
            load(0x2000, countdown);
            dbgr.debug(cpu.pc);
            keyPress("n");
            keyPress("t");
            keyPress("c");
            expect(pc()).toBe("2002");
            expect(cpu.x).toBe(2);
        });

        it("steps out through a return that has a breakpoint", () => {
            load(0x2000, [0x20, 0x00, 0x30]);
            load(0x3000, [0x60]);
            dbgr.debug(cpu.pc);
            keyPress("n");
            keyPress("t");
            keyPress("o");
            expect(pc()).toBe("2003");
        });

        it("steps out of an interrupt handler through its RTI", () => {
            // Push a return to $200A and the flags as an interrupt would, then enter the handler:
            // LDX #2; DEX; BNE $3002; RTI
            load(0x2000, [0xa9, 0x20, 0x48, 0xa9, 0x0a, 0x48, 0x08, 0x4c, 0x00, 0x30, 0xea]);
            load(0x3000, [0xa2, 0x02, 0xca, 0xd0, 0xfd, 0x40]);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$3002");
            keyPress("c");
            keyPress("o");
            expect(pc()).toBe("200a");
        });

        it("steps over an RTI to where it returns", () => {
            load(0x2000, [0xa9, 0x20, 0x48, 0xa9, 0x0a, 0x48, 0x08, 0x4c, 0x00, 0x30, 0xea]);
            load(0x3000, [0x40]);
            dbgr.debug(cpu.pc);
            goTo("goto-dis-addr-form", "$3000");
            keyPress("c");
            keyPress("m");
            expect(pc()).toBe("200a");
        });
    });

    describe("the watch panel", () => {
        let frames;

        beforeEach(() => {
            frames = fakeAnimationFrames();
            cpu.writemem(0x70, 0x05);
            cpu.writemem(0x71, 0x01);
        });

        afterEach(() => vi.restoreAllMocks());

        const panelOpen = () => !document.getElementById("watch-panel").hidden;
        const openFromMenu = () => dbgr.watches.floating.toggle();

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

        it("reads its watches once a frame as the machine moves on, without side effects, while open, and not at all while closed", () => {
            dbgr.debug(cpu.pc);
            addWatch("$70");
            dbgr.toggleDebugger();
            const peek = vi.spyOn(cpu, "peekmem");
            const read = vi.spyOn(cpu, "readmem");
            openFromMenu();
            expect(panelOpen()).toBe(true);
            peek.mockClear();
            cpu.writemem(0x70, 0x06);
            stoppedLoop.tick(2);
            read.mockClear();
            frames.run();
            frames.run();
            expect(watchRows()[0][1]).toBe("6");
            expect(peek).toHaveBeenCalledTimes(1);
            expect(frames.pending).toBe(1);
            openFromMenu();
            expect(panelOpen()).toBe(false);
            expect(frames.pending).toBe(0);
            peek.mockClear();
            cpu.writemem(0x70, 0x07);
            stoppedLoop.tick(2);
            read.mockClear();
            frames.run();
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

        it("leaves a watch's list of formats open when the machine steps or goes", () => {
            addWatch("$70");
            watchControl(0, "watch-format").click();
            dbgr.hide();
            expect(watchChoices(0).hidden).toBe(false);
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
        const symbolsLine = () => document.querySelector("#disassembly-panel .debug-symbols");
        const credited = () => symbolsLine().style.visibility !== "hidden";

        beforeEach(() => {
            [0x20, 0x00, 0x30, 0x8d, 0x40, 0xfe, 0xb1, 0xf2, 0x6c, 0x0e, 0x02, 0xa5, 0xf2].forEach((byte, i) =>
                cpu.writemem(0x2002 + i, byte),
            );
            [0x6c, 0x0e, 0x02, 0x60, 0xd0, 0xfa].forEach((byte, i) => cpu.writemem(OswrchAt + i, byte));
            load = vi.fn(async (url) => structuredClone(files.get(url)));
            dbgr.hidePanels();
            document.body.innerHTML = "";
            domFromIndexHtml(...PanelElements);
            dbgr = makeDebugger(new SymbolSets({ baseUrl: BaseUrl, load }));
        });

        it("names operands once the sets that match have arrived, noting a register by its own name", async () => {
            dbgr.debug(cpu.pc);
            expect(code(0x2002).textContent).toBe("JSR $3000");
            expect(credited()).toBe(false);
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            expect(code(0x2005).textContent).toBe("STA $fe40 ; SysVIA.ORB");
            expect(code(0x2005).querySelector(".note").title).toBe(
                "System VIA ORB: $fe40\nsystem_via_register_b: $fe40, from Test MOS",
            );
            expect(code(0x2008).textContent).toMatch(/^LDA \(os_text_ptr\),Y ; \$[0-9a-f]{4} \+ Y$/);
            expect(code(0x200a).textContent).toMatch(/^JMP \(wrchv\) ; \$/);
            expect(code(0x200d).textContent).toBe("LDA os_text_ptr");
            expect(code(0x2000).textContent).toBe("LDA #$41");
            expect(code(0x2002).querySelector(".instr_instr_ref").title).toBe("oswrch: $3000, from Test MOS");
            expect(credited()).toBe(true);
            expect(symbolsLine().textContent).toBe("names from Test MOS (source)");
            expect(symbolsLine().querySelector(".symbol-set").title).toBe("MIT\n\nCopyright the test");
            expect(symbolsLine().title).toBe("names from Test MOS (source)");
            expect(symbolsLine().querySelector("a").href).toBe("https://example.com/mos.lst");
        });

        it("keeps a program's own name for a SHEILA register, over the register's", async () => {
            withMos((mos) => (mos.system = false));
            [0x8d, 0x40, 0xfe].forEach((byte, i) => cpu.writemem(OswrchAt + 6 + i, byte));
            dbgr.debug(OswrchAt);
            await vi.waitFor(() => expect(code(OswrchAt + 6).textContent).toBe("STA system_via_register_b"));
            expect(code(OswrchAt + 6).querySelector(".instr_mem_ref").title).toBe(
                "system_via_register_b: $fe40, from Test MOS\nSystem VIA ORB: $fe40",
            );
            rightClick(code(OswrchAt + 6).querySelector(".instr_mem_ref"));
            pickFromMenu("Watch hex");
            expect(watchRows().map(([name]) => name)).toEqual(["system_via_register_b"]);
            document.getElementById("watch-close").click();
        });

        it("doesn't credit a system set whose only name in view gives way to a register's", async () => {
            [0x8d, 0x40, 0xfe].forEach((byte, i) => cpu.writemem(0x5000 + i, byte));
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            dbgr.updateDisassembly(0x5000);
            expect(code(0x5000).textContent).toBe("STA $fe40 ; SysVIA.ORB");
            expect(credited()).toBe(false);
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
            expect(memTarget().dataset.addr).toBe(`${0xf2}`);
        });

        it("still follows a named zero-page operand to the memory view", async () => {
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(code(0x200d).textContent).toBe("LDA os_text_ptr"));
            code(0x200d)
                .querySelector(".instr_mem_ref")
                .dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(memTarget().dataset.addr).toBe(`${0xf2}`);
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

        it("credits a set whose names only the memory view shows in the memory panel's own line", async () => {
            const memoryLine = () => document.querySelector("#memory-panel .debug-symbols");
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            dbgr.updateDisassembly(0x8000);
            expect(credited()).toBe(false);
            goTo("goto-mem-addr-form", "$3000");
            expect(memoryLine().textContent).toBe("names from Test MOS (source)");
            expect(credited()).toBe(false);
            goTo("goto-mem-addr-form", "$1000");
            expect(memoryLine().style.visibility).toBe("hidden");
        });

        it("watches a name typed while the machine runs, once opening the panel has fetched its set", async () => {
            dbgr.watches.floating.toggle();
            await vi.waitFor(() => expect(load).toHaveBeenCalledWith(`${BaseUrl}mos.json`));
            await vi.waitFor(() => expect(load.mock.settledResults.at(-1)?.type).toBe("fulfilled"));
            await new Promise((resolve) => setTimeout(resolve, 0));
            addWatch("oswrch");
            expect(watchRows()).toEqual([["oswrch", "108", "dec", "\u00d7"]]);
            expect(dbgr.inDebugger()).toBe(false);
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

        it("labels an operand by its hex when the disassembly shows no name beside it", async () => {
            withMos((mos) => (mos.workspace = { scratch: "0x70" }));
            [0xa5, 0x70].forEach((byte, i) => cpu.writemem(0x2010 + i, byte));
            cpu.pc = OswrchAt;
            dbgr.debug(cpu.pc);
            await vi.waitFor(() => expect(credited()).toBe(true));
            dbgr.updateDisassembly(0x2010);
            expect(code(0x2010).textContent).toBe("LDA $70");
            rightClick(code(0x2010).querySelector(".instr_mem_ref"));
            pickFromMenu("Watch dec");
            expect(watchRows().map(([name]) => name)).toEqual(["$0070"]);
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
            expect(symbolsLine().hidden).toBe(false);
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

        it("names the panels shown while the machine runs once the index and its sets arrive", async () => {
            stoppedLoop.go();
            dbgr.togglePanels();
            await vi.waitFor(() => expect(code(0x2002).textContent).toBe("JSR oswrch"));
            expect(credited()).toBe(true);
        });

        it("fetches nothing for the decoded system VIA open on its own, even reopened before the machine starts", async () => {
            new SysViaPanel({ cpu, arrangement }).floating.open();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(load).not.toHaveBeenCalled();
            dbgr.setCpu(cpu);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(load).not.toHaveBeenCalled();
        });

        it("waits for the next stop to look for sets when the index arrives with the panels shut", async () => {
            dbgr.debug(cpu.pc);
            dbgr.toggleDebugger();
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
