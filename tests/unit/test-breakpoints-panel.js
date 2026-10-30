// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fake6502 } from "../../src/fake6502.js";
import { findModel } from "../../src/models.js";
import { parseAddr } from "../../src/hex.js";
import { BreakpointsPanel } from "../../src/web/breakpoints-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { teardownDom } from "./helpers.js";

const StorageKey = "debugBreakpoints";

describe("BreakpointsPanel", () => {
    let cpu;
    let panel;

    const names = new Map([["oswrch", 0xffee]]);
    const resolve = (text) => {
        const address = names.get(text) ?? parseAddr(text);
        return address === undefined ? undefined : { address, name: names.has(text) ? text : undefined };
    };

    const makePanel = async (model) => {
        cpu = fake6502(model);
        panel = new BreakpointsPanel({
            arrangement: new PanelArrangement(() => window.localStorage),
            resolve,
            nameOf: (address) => [...names].find(([, at]) => at === address)?.[0],
            showCode: () => {},
            showMemory: () => {},
            storage: () => window.localStorage,
        });
        panel.setCpu(cpu);
        panel.floating.open();
    };

    beforeEach(async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        // jsdom's window never has the focus; a browser's does while it is in front.
        vi.spyOn(document, "hasFocus").mockReturnValue(true);
        window.localStorage.clear();
        await makePanel(findModel("B-DFS1.2"));
    });

    afterEach(teardownDom);

    const revisit = async (model) => {
        document.body.innerHTML = "";
        await makePanel(model);
    };

    const rows = () => [...panel.panel.querySelectorAll(".bp-list tr")];
    const rowText = (row) =>
        [...row.querySelectorAll("td")].map((td) =>
            [...td.childNodes]
                .map((node) => node.textContent.trim())
                .filter(Boolean)
                .join(" "),
        );
    const click = (element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = () => panel.panel.querySelector(".bp-add");
    const type = (field, text) => {
        field.value = text;
        field.dispatchEvent(new Event("input"));
    };
    const enter = (field) => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const addTyped = (text) => {
        type(input(), text);
        panel.panel.querySelector(".bp-add-form").requestSubmit();
    };
    const saved = () => JSON.parse(window.localStorage.getItem(StorageKey));

    it("lists every breakpoint, however it was set, saying when there are none", () => {
        expect(panel.panel.querySelector(".bp-empty").hidden).toBe(false);
        cpu.breakpoints.add({ kind: "write", start: 0x3000, end: 0x30ff, condition: "value != old", action: "log" });
        cpu.breakpoints.add({ kind: "execute", start: 0x8003, hitCount: 3, owner: "script" });
        cpu.breakpoints.add({ kind: "execute", start: 0xffee });
        expect(rows().map(rowText)).toEqual([
            ["", "W", "$3000-$30ff", "value != old", "0", "log", "×"],
            ["", "X", "$8003 (from script) any ROM", "always", "0 of 3", "stop", "×"],
            ["", "X", "$ffee oswrch", "always", "0", "stop", "×"],
        ]);
        expect(panel.panel.querySelector(".bp-empty").hidden).toBe(true);
    });

    it("adds what is typed, as an address, a range or a name, of the kind chosen", () => {
        addTyped("2000");
        click(panel.panel.querySelector(".bp-add-kind"));
        addTyped("3000 - 30ff");
        click(panel.panel.querySelector(".bp-add-kind"));
        addTyped("oswrch");
        expect(cpu.breakpoints.list().map(({ kind, start, end, label }) => [kind, start, end, label])).toEqual([
            ["execute", 0x2000, 0x2000, undefined],
            ["read", 0x3000, 0x30ff, undefined],
            ["write", 0xffee, 0xffee, "oswrch"],
        ]);
        expect(input().value).toBe("");
    });

    it.each([
        ["nowhere", 'No address called "nowhere"'],
        ["3000-2000", "Breakpoint end $2000 is before its start $3000"],
        ["3000-30ff-4000", '"3000-30ff-4000" is not an address or a range of two'],
    ])("marks %j as not an address, keeping it", (text, message) => {
        addTyped(text);
        expect(input().classList.contains("is-invalid")).toBe(true);
        expect(input().title).toBe(message);
        expect(input().value).toBe(text);
        expect(cpu.breakpoints.list()).toEqual([]);
    });

    it("enables, switches between stop and log, and removes from each row", () => {
        const id = cpu.breakpoints.add({ kind: "read", start: 0x70 });
        click(rows()[0].querySelector(".bp-enabled"));
        expect(cpu.breakpoints.get(id).enabled).toBe(false);
        click(rows()[0].querySelector(".bp-action"));
        expect(cpu.breakpoints.get(id).action).toBe("log");
        click(rows()[0].querySelector(".bp-remove"));
        expect(cpu.breakpoints.list()).toEqual([]);
    });

    it("puts a field back as it was on Escape, keeping it, with the keyboard, across changes made meanwhile", () => {
        const id = cpu.breakpoints.add({ kind: "execute", start: 0x2000, condition: "A = 1" });
        const other = cpu.breakpoints.add({ kind: "read", start: 0x70 });
        click(rows()[0].querySelector(".bp-condition .txt-btn"));
        const condition = rows()[0].querySelector(".bp-edit");
        type(condition, "A = 2");
        click(rows()[1].querySelector(".bp-enabled"));
        cpu.breakpoints.add({ kind: "write", start: 0x71 });
        expect(cpu.breakpoints.get(other).enabled).toBe(false);
        expect(rows()[1].querySelector(".bp-enabled").classList.contains("disabled")).toBe(true);
        expect(rows()[0].querySelector(".bp-edit")).toBe(condition);
        expect(document.activeElement).toBe(condition);
        condition.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(rows().map((row) => rowText(row)[3])).toEqual(["A = 1", "always", "always"]);
        expect(cpu.breakpoints.get(id).condition).toBe("A = 1");
    });

    it("keeps a field while the window is away, say in the browser's console", () => {
        cpu.breakpoints.add({ kind: "execute", start: 0x2000 });
        click(rows()[0].querySelector(".bp-condition .txt-btn"));
        const condition = rows()[0].querySelector(".bp-edit");
        type(condition, "A = 2");
        document.hasFocus.mockReturnValue(false);
        condition.blur();
        expect(rows()[0].querySelector(".bp-edit")).toBe(condition);
        expect(condition.value).toBe("A = 2");
    });

    it("moves straight from one field to another", () => {
        cpu.breakpoints.add({ kind: "execute", start: 0x2000 });
        click(rows()[0].querySelector(".bp-condition .txt-btn"));
        click(rows()[0].querySelector(".bp-hits"));
        expect([...panel.panel.querySelectorAll(".bp-edit")].map((field) => field.value)).toEqual(["1"]);
        expect(document.activeElement).toBe(rows()[0].querySelector(".bp-hit-count .bp-edit"));
    });

    it("edits a condition and a hit count in place, keeping a bad condition for fixing", () => {
        const id = cpu.breakpoints.add({ kind: "execute", start: 0x2000 });
        click(rows()[0].querySelector(".bp-condition .txt-btn"));
        const condition = rows()[0].querySelector(".bp-edit");
        type(condition, "A =");
        enter(condition);
        expect(condition.title).toBe('Bad condition "A =": expected a value at column 4');
        type(condition, "A = &0D");
        enter(condition);
        click(rows()[0].querySelector(".bp-hits"));
        const hitCount = rows()[0].querySelector(".bp-edit");
        type(hitCount, "5");
        enter(hitCount);
        expect(cpu.breakpoints.get(id)).toMatchObject({ condition: "A = &0D", hitCount: 5 });
    });

    it("offers a bank for sideways addresses, or where one is set", () => {
        cpu.breakpoints.add({ kind: "execute", start: 0x2000 });
        cpu.breakpoints.add({ kind: "execute", start: 0x7f00, end: 0x80ff, bank: 15 });
        expect(rows().map((row) => row.querySelector(".bp-bank")?.textContent)).toEqual([undefined, "ROM 15"]);
    });

    it("offers no bank on the Atom unless one is set", async () => {
        await revisit(findModel("Atom"));
        cpu.breakpoints.add({ kind: "execute", start: 0x8000 });
        cpu.breakpoints.add({ kind: "execute", start: 0x8000, bank: 15 });
        expect(rows().map((row) => row.querySelector(".bp-bank")?.textContent)).toEqual([undefined, "ROM 15"]);
    });

    it("pins a sideways breakpoint to the bank paged in now, and back to any", () => {
        const id = cpu.breakpoints.add({ kind: "execute", start: 0x8000 });
        cpu.romSelect(0x0e);
        click(rows()[0].querySelector(".bp-bank"));
        expect(cpu.breakpoints.get(id).bank).toBe(cpu.pagedBank);
        expect(rows()[0].querySelector(".bp-bank").textContent).toBe(`ROM ${cpu.pagedBank}`);
        click(rows()[0].querySelector(".bp-bank"));
        expect(cpu.breakpoints.get(id).bank).toBeUndefined();
    });

    it("marks the breakpoint that stopped the machine, and counts hits once a frame", async () => {
        await revisit(null);
        await cpu.initialise();
        [0xa9, 0x41, 0x4c, 0x00, 0x20].forEach((byte, i) => cpu.writemem(0x2000 + i, byte));
        cpu.pc = 0x2000;
        cpu.p.i = true;
        cpu.breakpoints.add({ kind: "execute", start: 0x2000, action: "log" });
        cpu.breakpoints.add({ kind: "execute", start: 0x2002, hitCount: 2 });
        expect(cpu.execute(1000)).toBe(false);
        panel.update();
        expect(rows().map((row) => row.classList.contains("bp-stopped"))).toEqual([false, true]);
        expect(rows().map((row) => row.querySelector(".bp-hits").textContent)).toEqual(["2", "2 of 2"]);
    });

    it("saves the user's breakpoints and puts them back on the next visit", async () => {
        cpu.breakpoints.add({ kind: "write", start: 0x3000, end: 0x3001, condition: "value != old", label: "flag" });
        cpu.breakpoints.add({ kind: "execute", start: 0x2000, enabled: false, hitCount: 2, action: "log" });
        cpu.breakpoints.add({ kind: "write", start: 0x70, owner: "script" });
        cpu.breakpoints.add({ kind: "execute", start: 0x8000, bank: 4 });
        await revisit(findModel("B-stock"));
        expect(
            cpu.breakpoints.list().map(({ kind, start, end, condition, label, enabled, hitCount, action }) => ({
                kind,
                start,
                end,
                condition,
                label,
                enabled,
                hitCount,
                action,
            })),
        ).toEqual([
            {
                kind: "write",
                start: 0x3000,
                end: 0x3001,
                condition: "value != old",
                label: "flag",
                enabled: true,
                hitCount: 1,
                action: "stop",
            },
            {
                kind: "execute",
                start: 0x2000,
                end: 0x2000,
                condition: undefined,
                label: undefined,
                enabled: false,
                hitCount: 2,
                action: "log",
            },
        ]);
        cpu.breakpoints.add({ kind: "read", start: 0x70 });
        expect(saved().breakpoints.map(({ start }) => start)).toEqual([0x3000, 0x2000, 0x70, 0x8000]);
        await revisit(findModel("B-DFS1.2"));
        expect(cpu.breakpoints.list().map(({ start, bank }) => [start, bank])).toEqual([
            [0x3000, undefined],
            [0x2000, undefined],
            [0x70, undefined],
            [0x8000, 4],
        ]);
    });

    it("drops a saved entry that is not a breakpoint, with a warning, keeping the rest", async () => {
        const good = { kind: "read", start: 0x70 };
        window.localStorage.setItem(
            StorageKey,
            JSON.stringify({
                version: 1,
                breakpoints: [
                    good,
                    { kind: "jump", start: 0 },
                    { kind: "read", start: 0x8000, bank: 4, condition: "A =" },
                ],
            }),
        );
        await revisit(findModel("B-stock"));
        expect(console.warn).toHaveBeenCalledWith(
            "Could not put back a saved breakpoint: Unknown breakpoint type: jump",
        );
        expect(cpu.breakpoints.list().map(({ start }) => start)).toEqual([0x70]);
        cpu.breakpoints.add({ kind: "read", start: 0x71 });
        expect(saved().breakpoints.map(({ start }) => start)).toEqual([0x70, 0x71]);
    });

    it.each([
        ["not JSON", "{"],
        ["another version", JSON.stringify({ version: 99, breakpoints: [{ kind: "read", start: 0 }] })],
    ])("starts with none when what is saved is %s", async (_, text) => {
        window.localStorage.setItem(StorageKey, text);
        await revisit(null);
        expect(cpu.breakpoints.list()).toEqual([]);
    });

    describe("Stop on", () => {
        const menu = () => document.querySelector(".bp-stop-menu");
        const choices = () => [...menu().querySelectorAll(".bp-stop-choice")];
        const openMenu = () => click(panel.panel.querySelector(".bp-stop-on"));
        const pick = (name) => {
            openMenu();
            click(choices().find((choice) => choice.textContent === name));
        };
        const specs = () =>
            cpu.breakpoints.list().map(({ kind, start, end, line, condition, label }) => ({
                kind,
                start,
                end,
                line,
                condition,
                label,
            }));
        const Events = ["BRK", "Undocumented opcode", "IRQ", "NMI", "Vsync", "Raster line"];
        const preset = (kind, start, end, label, condition) => ({
            kind,
            start,
            end,
            line: undefined,
            condition,
            label,
        });

        it.each([
            [
                "B-DFS1.2",
                [
                    ["Code in I/O", preset("execute", 0xfc00, 0xfeff, "I/O")],
                    ["ROMSEL write", preset("write", 0xfe30, 0xfe3f, "ROMSEL")],
                    ["Disc command", preset("write", 0xfe80, 0xfe80, "disc command")],
                    ["Sound write", preset("write", 0xfe40, 0xfe40, "sound", "(value AND 15) = 0")],
                ],
            ],
            [
                "Master",
                [
                    ["Code in I/O", preset("execute", 0xfc00, 0xfeff, "I/O")],
                    ["ROMSEL write", preset("write", 0xfe30, 0xfe33, "ROMSEL")],
                    ["ACCCON write", preset("write", 0xfe34, 0xfe37, "ACCCON")],
                    ["Disc command", preset("write", 0xfe28, 0xfe28, "disc command")],
                    ["Sound write", preset("write", 0xfe40, 0xfe40, "sound", "(value AND 15) = 0")],
                ],
            ],
            ["Atom", []],
        ])(
            "on the %s offers the stops with no address, then those at the machine's registers",
            async (model, presets) => {
                await revisit(findModel(model));
                openMenu();
                expect(choices().map((choice) => choice.textContent)).toEqual([
                    ...Events,
                    ...presets.map(([name]) => name),
                ]);
                expect(menu().querySelector(".bp-stop-rule").hidden).toBe(presets.length === 0);
                for (const [name] of presets) pick(name);
                expect(specs()).toEqual(presets.map(([, spec]) => spec));
            },
        );

        it("stops at a write that strobes the sound chip, and not at the write that ends it", () => {
            const Program = 0x2000;
            const SoundStrobe = 0x2007;
            // LDA #8, STA &FE40, LDA #0, STA &FE40, JMP &200A
            const Strobes = [0xa9, 0x08, 0x8d, 0x40, 0xfe, 0xa9, 0x00, 0x8d, 0x40, 0xfe, 0x4c, 0x0a, 0x20];
            cpu.reset(true);
            Strobes.forEach((byte, i) => cpu.writemem(Program + i, byte));
            cpu.pc = Program;
            cpu.p.i = true;
            const hits = [];
            cpu.breakpoints.onHit((hit) => hits.push(hit));
            pick("Sound write");
            expect(cpu.execute(1000)).toBe(false);
            expect(hits).toEqual([expect.objectContaining({ pc: SoundStrobe, value: 0 })]);
        });

        it("adds a stop with no address, closing the menu and leaving the keyboard to the machine", () => {
            input().focus();
            pick("BRK");
            pick("IRQ");
            expect(menu().hidden).toBe(true);
            expect(document.activeElement).toBe(document.body);
            expect(specs().map(({ kind }) => kind)).toEqual(["brk", "irq"]);
            expect(rows().map(rowText)).toEqual([
                ["", "BRK", "any BRK", "always", "0", "stop", "×"],
                ["", "IRQ", "IRQ entry", "always", "0", "stop", "×"],
            ]);
        });

        it("stops at the raster line typed in the field, which it marks when it holds none", () => {
            pick("Raster line");
            expect(input().title).toBe("Type the TV line to stop at here, then pick Raster line");
            expect(cpu.breakpoints.list()).toEqual([]);
            type(input(), "100");
            pick("Raster line");
            expect(input().value).toBe("");
            expect(specs()).toEqual([{ ...preset("line"), line: 100 }]);
            click(rows()[0].querySelector(".bp-line"));
            const line = rows()[0].querySelector(".bp-edit");
            type(line, "x");
            enter(line);
            expect(line.title).toBe("Line x is not a whole number from 0");
            type(line, "120");
            enter(line);
            expect(rowText(rows()[0])).toEqual(["", "LN", "line 120", "always", "0", "stop", "×"]);
        });

        it("closes on a click elsewhere, adding nothing", () => {
            openMenu();
            document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
            expect(menu().hidden).toBe(true);
            expect(cpu.breakpoints.list()).toEqual([]);
        });

        it("saves a raster line, and puts it back on the next visit", async () => {
            cpu.breakpoints.add({ kind: "line", line: 50, hitCount: 2 });
            await revisit(findModel("B-DFS1.2"));
            expect(cpu.breakpoints.list()).toEqual([expect.objectContaining({ kind: "line", line: 50, hitCount: 2 })]);
        });
    });
});
