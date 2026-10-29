// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { fake6502 } from "../../src/fake6502.js";
import { findModel } from "../../src/models.js";
import { PagingPanel } from "../../src/web/paging-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { decodedMeanings, fitRomHeader, romless, teardownDom } from "./helpers.js";

describe("PagingPanel", () => {
    let cpu;
    let panel;
    let showBank;

    const open = async (name) => {
        cpu = fake6502(romless(name));
        await cpu.initialise();
        showBank = vi.fn();
        panel = new PagingPanel({ cpu, arrangement: new PanelArrangement(() => window.localStorage), showBank });
    };

    afterEach(teardownDom);

    const meanings = (name) => decodedMeanings("paging-panel", name);
    const sockets = () =>
        [...document.querySelectorAll("#paging-panel .socket")].map((row) => [
            ...[...row.children].map((part) => part.textContent),
            row.classList.contains("paged"),
        ]);

    it("names the bank ROMSEL pages and, on a Master, ANDY and each bit of ACCCON", async () => {
        await open("Master");
        cpu.romSelect(0x8c);
        cpu.writeAcccon(0x0c);
        panel.update();
        expect(meanings("ROMSEL")).toEqual(["bank C", "+ANDY"]);
        expect(meanings("ACCCON")).toEqual(["-IRR", "-TST", "-IFJ", "-ITU", "+Y", "+X", "-E", "-D"]);
    });

    it("lists each socket's ROM by title, lighting the paged one, and shows a socket's bank when clicked", async () => {
        await open("B-DFS1.2");
        fitRomHeader(cpu, 15, "BASIC");
        fitRomHeader(cpu, 14, "DFS", "1.20");
        cpu.romSelect(14);
        panel.update();
        expect(meanings("ROMSEL")).toEqual(["bank E"]);
        const rows = sockets();
        expect(rows.slice(0, 3)).toEqual([
            ["F", "ROM", "BASIC", false],
            ["E", "ROM", "DFS 1.20", true],
            ["D", "ROM", "empty", false],
        ]);
        expect(rows[15]).toEqual(["0", "RAM", "sideways RAM", false]);
        document.querySelectorAll("#paging-panel .socket")[1].click();
        expect(showBank).toHaveBeenCalledWith(14);
    });

    it("lists only the sockets a four-socket B's ROMSEL reaches", async () => {
        await open("B-stock");
        expect(sockets().map(([bank, kind]) => `${bank} ${kind}`)).toEqual(["F ROM", "E ROM", "D ROM", "C ROM"]);
        expect(document.querySelector("#paging-panel").textContent).not.toContain("ACCCON");
    });

    it("has nothing to show on the Atom", () => {
        expect(PagingPanel.fits({ model: findModel("Atom") })).toBe(false);
        expect(PagingPanel.fits({ model: findModel("Master") })).toBe(true);
    });
});
