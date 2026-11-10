// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { fake6502 } from "../../src/fake6502.js";
import { CallStackPanel } from "../../src/web/call-stack-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { cycleCount } from "../../src/lockstep.js";
import { durationText } from "../../src/replay.js";
import { teardownDom } from "./helpers.js";

const Inner = { kind: "JSR", cycle: 0, site: 0x3000, routine: 0xffee, siteBank: undefined, routineBank: undefined };
const Outer = { kind: "IRQ", cycle: 0, site: 0x8f14, routine: 0xdc1c, siteBank: 15, routineBank: undefined };
const Names = new Map([[0xffee, "OSWRCH"]]);

describe("CallStackPanel", () => {
    let cpu;
    let panel;
    let stopped;
    let showCode;
    let searches;
    let resumed;

    /**
     * A panel whose searches each yield [Inner] once, then end as `found`, or the first as `first` if given, unless
     * `refusal` says why not.
     */
    const open = async ({ found, refusal, first }) => {
        cpu = fake6502(null);
        await cpu.initialise();
        stopped = true;
        showCode = vi.fn();
        searches = [];
        resumed = 0;
        panel = new CallStackPanel({
            arrangement: new PanelArrangement(() => window.localStorage),
            refusal: () => refusal,
            search: () => {
                const ending = searches.length === 0 && first ? first : found;
                const search = (function* () {
                    yield [Inner];
                    resumed++;
                    return ending;
                })();
                searches.push(search);
                return search;
            },
            isStopped: () => stopped,
            nameOf: (address) => Names.get(address),
            showCode,
        });
        panel.setCpu(cpu);
        panel.floating.open();
    };

    afterEach(teardownDom);

    const rows = () =>
        [...panel.panel.querySelectorAll("tr")].map((row) =>
            [...row.cells].map((cell) =>
                [...cell.childNodes]
                    .map((node) => node.textContent.trim())
                    .filter(Boolean)
                    .join(" "),
            ),
        );
    const endLine = () => panel.panel.querySelector(".cs-end");
    const searched = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("shows the frames found so far while it searches, then the rest, each address showing its code", async () => {
        await open({ found: { frames: [Inner, Outer], accounted: true, txsAt: null, stoppedBy: null } });
        expect(rows()).toEqual([["JSR", "$ffee OSWRCH", "from $3000"]]);
        expect(panel.panel.querySelector("tr").title).toBe(
            `A JSR called this routine ${cycleCount(cpu)} cycles (${durationText(cycleCount(cpu) / cpu.model.cyclesPerSecond)}) ago`,
        );
        expect(endLine().textContent).toMatch(/Searching back/);
        await searched();
        expect(rows()).toEqual([
            ["JSR", "$ffee OSWRCH", "from $3000"],
            ["IRQ", "$dc1c", "from $8f14 bank F"],
        ]);
        expect(endLine().hidden).toBe(true);
        panel.panel.querySelectorAll(".cs-address")[3].click();
        expect(showCode).toHaveBeenCalledWith(0x8f14, 15);
    });

    it.each([
        ["none, inside no call", { frames: [], accounted: true, txsAt: null, stoppedBy: null }, /^Not inside any call/],
        ["a TXS", { frames: [Inner], accounted: true, txsAt: 0x2002, stoppedBy: null }, /^The TXS at \$2002 moved/],
        [
            "the history's end",
            { frames: [Inner], accounted: false, txsAt: null, stoppedBy: null },
            /predate the history/,
        ],
        [
            "what the search cannot go back past",
            { frames: [Inner], accounted: false, txsAt: null, stoppedBy: "a disc change" },
            /cannot go back past a disc change\.$/,
        ],
        ["the search's refusal", { refusal: "The call stack is not available." }, /^The call stack is not available/],
    ])("says why it shows no older frames: %s", async (_, found, why) => {
        await open({ found });
        await searched();
        expect(endLine().textContent).toMatch(why);
    });

    it("says why it cannot search at all", async () => {
        await open({ refusal: "No history." });
        expect([rows(), endLine().textContent, searches.length]).toEqual([[], "No history.", 0]);
    });

    it.each([
        [
            "the machine runs",
            () => {
                stopped = false;
                panel.update();
                expect(endLine().textContent).toBe("The call stack shows while the machine is stopped.");
                stopped = true;
            },
        ],
        ["the panel closes", () => panel.floating.close()],
        ["the machine steps", () => cpu.execute(1)],
        ["the machine is set running, before the panel is drawn again", () => (stopped = false)],
    ])("ends its search once %s, and searches afresh where it is next shown stopped", async (_, interrupt) => {
        await open({ found: { frames: [Inner], accounted: true, txsAt: null, stoppedBy: null } });
        interrupt();
        await searched();
        expect(resumed).toBe(0);
        stopped = true;
        panel.floating.open();
        panel.update();
        expect(searches).toHaveLength(2);
        await searched();
        expect(resumed).toBe(1);
    });

    it("searches afresh when the machine moved on without a cycle passing", async () => {
        const found = { frames: [Inner, Outer], accounted: true, txsAt: null, stoppedBy: null };
        await open({ found, first: { refusal: "Moved on.", movedOn: true } });
        await searched();
        expect(searches).toHaveLength(2);
        await searched();
        expect(rows()).toHaveLength(2);
    });
});
