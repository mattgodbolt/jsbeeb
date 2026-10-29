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
    let showCode;
    let showMemory;

    const names = new Map([["oswrch", 0xffee]]);
    const resolve = (text) => {
        const address = names.get(text) ?? parseAddr(text);
        return address === undefined ? undefined : { address, label: names.has(text) ? text : `$${text}` };
    };

    const makePanel = async (model) => {
        cpu = fake6502(model);
        showCode = vi.fn();
        showMemory = vi.fn();
        panel = new BreakpointsPanel({
            arrangement: new PanelArrangement(() => window.localStorage),
            resolve,
            nameOf: (address) => [...names].find(([, at]) => at === address)?.[0],
            showCode,
            showMemory,
            storage: () => window.localStorage,
        });
        panel.setCpu(cpu);
        panel.floating.open();
    };

    beforeEach(async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
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
        cpu.breakpoints.add({ kind: "execute", start: 0x8003, hitCount: 3, owner: "Watches" });
        cpu.breakpoints.add({ kind: "execute", start: 0xffee });
        expect(rows().map(rowText)).toEqual([
            ["", "W", "$3000-$30ff", "value != old", "0", "log", "×"],
            ["", "X", "$8003 (from Watches) any ROM", "always", "0 of 3", "stop", "×"],
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
        expect(cpu.onFastPath).toBe(true);
        click(rows()[0].querySelector(".bp-action"));
        expect(cpu.breakpoints.get(id).action).toBe("log");
        click(rows()[0].querySelector(".bp-remove"));
        expect(cpu.breakpoints.list()).toEqual([]);
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

    it("shows code for an execute breakpoint and memory for the others", () => {
        cpu.breakpoints.add({ kind: "execute", start: 0x2000 });
        cpu.breakpoints.add({ kind: "access", start: 0xfe40 });
        click(rows()[0].querySelector(".bp-where"));
        click(rows()[1].querySelector(".bp-where"));
        expect(showCode).toHaveBeenCalledWith(0x2000);
        expect(showMemory).toHaveBeenCalledWith(0xfe40);
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
        cpu.breakpoints.add({ kind: "write", start: 0x70, owner: "Watches" });
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
        expect(saved().breakpoints.map(({ start }) => start)).toEqual([0x3000, 0x2000, 0x8000]);
        await revisit(findModel("B-DFS1.2"));
        expect(cpu.breakpoints.list().map(({ start, bank }) => [start, bank])).toEqual([
            [0x3000, undefined],
            [0x2000, undefined],
            [0x8000, 4],
        ]);
    });

    it.each([
        ["not JSON", "{"],
        ["another version", JSON.stringify({ version: 99, breakpoints: [{ kind: "read", start: 0 }] })],
    ])("starts with none when what is saved is %s", async (_, text) => {
        window.localStorage.setItem(StorageKey, text);
        await revisit(null);
        expect(cpu.breakpoints.list()).toEqual([]);
    });
});
