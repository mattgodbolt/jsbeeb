// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { helpRows, keyLine, PanelKeys } from "../../src/web/panel-keys.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { DisassemblyKeys, MemoryKeys, ToolbarKeys } from "../../src/web/debug.js";
import { PauseKeys } from "../../src/web/keyboard-setup.js";
import { bareFloatingPanel, teardownDom } from "./helpers.js";

const Tables = { ToolbarKeys, DisassemblyKeys, MemoryKeys, PauseKeys };

describe("PanelKeys", () => {
    let arrangement;
    let keys;

    const panel = (id) => bareFloatingPanel(arrangement, id, id);
    const owner = (floating, table) => {
        const actions = Object.fromEntries(table.filter((row) => row.run).map((row) => [row.run, vi.fn()]));
        keys.register({ table, actions, isLive: () => floating?.isOpen ?? true, panel: floating });
        return actions;
    };

    beforeEach(() => {
        arrangement = new PanelArrangement(() => window.localStorage);
        keys = new PanelKeys(arrangement);
    });

    afterEach(teardownDom);

    it("runs the action an open panel binds a key to, and claims nothing for a key nobody binds", () => {
        const memory = panel("memory");
        const actions = owner(memory, [{ key: "u", run: "forward" }]);
        expect(keys.press("u")).toBe(false);
        memory.open();
        expect(keys.press("u")).toBe(true);
        expect(actions.forward).toHaveBeenCalledTimes(1);
        expect(keys.press("q")).toBe(false);
    });

    it("gives a key two open panels bind to the one clicked most recently", () => {
        const disassembly = panel("disassembly");
        const memory = panel("memory");
        const fromDisassembly = owner(disassembly, [{ key: "n", run: "next" }]);
        const fromMemory = owner(memory, [{ key: "n", run: "next" }]);
        disassembly.open();
        memory.open();
        keys.press("n");
        expect(fromMemory.next).toHaveBeenCalledTimes(1);
        disassembly.panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        keys.press("n");
        expect(fromDisassembly.next).toHaveBeenCalledTimes(1);
        expect(fromMemory.next).toHaveBeenCalledTimes(1);
    });

    it("leaves a key to keys beneath every panel only when no open panel binds it", () => {
        const toolbar = panel("toolbar");
        const pause = owner(null, [{ key: "n", run: "frame" }]);
        const fromToolbar = owner(toolbar, [{ key: "n", run: "step" }]);
        keys.press("n");
        expect(pause.frame).toHaveBeenCalledTimes(1);
        toolbar.open();
        keys.press("n");
        expect(fromToolbar.step).toHaveBeenCalledTimes(1);
        expect(pause.frame).toHaveBeenCalledTimes(1);
    });
});

describe("Key tables", () => {
    afterEach(teardownDom);

    describe.each(Object.entries(Tables))("%s", (_, table) => {
        const handled = table.filter((row) => row.key);
        const documentedKeys = table.filter((row) => row.description).flatMap((row) => row.combo.split(" "));

        it("documents every key it handles, and handles every key it documents", () => {
            expect([...documentedKeys].sort()).toEqual(handled.map((row) => row.key).sort());
        });

        it("binds each key once", () => {
            expect(new Set(handled.map((row) => row.key)).size).toBe(handled.length);
        });
    });

    it("gives the debugger's run and step keys and its panels' keys apart", () => {
        const debuggerKeys = [ToolbarKeys, DisassemblyKeys, MemoryKeys].flatMap((table) =>
            table.filter((row) => row.key).map((row) => row.key),
        );
        expect(new Set(debuggerKeys).size).toBe(debuggerKeys.length);
    });

    it("makes a panel's line of keys from its labelled rows", () => {
        expect(keyLine(DisassemblyKeys)).toBe("c run to cursor · t breakpoint · j/k move · b back");
        expect(keyLine(MemoryKeys)).toBe("u/i/U/I ±8, ±64");
    });

    it("makes Help's rows, a key cap for each key", () => {
        const rows = helpRows([MemoryKeys]);
        expect(rows.map((row) => row.textContent)).toEqual([
            "u i U IMemory forward (u, U) or back (i, I), 8 or 64 bytes",
        ]);
        expect([...rows[0].querySelectorAll(".key")].map((cap) => cap.textContent)).toEqual(["u", "i", "U", "I"]);
    });
});
