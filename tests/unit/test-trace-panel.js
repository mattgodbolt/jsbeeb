// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { fake6502 } from "../../src/fake6502.js";
import { hexbyte, hexword } from "../../src/hex.js";
import { TraceDepth } from "../../src/instruction-trace.js";
import { cycleCount } from "../../src/lockstep.js";
import { ReplayHistory } from "../../src/replay.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { TracePanel } from "../../src/web/trace-panel.js";
import { loadBytes, teardownDom } from "./helpers.js";

const LoopAt = 0x2002;
// LDX #0, then INX and JMP back to it for ever.
const CountForever = [0xa2, 0x00, 0xe8, 0x4c, LoopAt & 0xff, LoopAt >>> 8];
const Nop = 0xea;
const ManyCycles = 5000;
const FewCycles = 20;

describe("TracePanel", () => {
    let cpu;
    let history;
    let stopped;
    let unavailable;
    let showCode;
    let panel;

    async function counting() {
        cpu = fake6502(null);
        await cpu.initialise();
        loadBytes(cpu, LoopAt - 2, CountForever);
        cpu.pc = LoopAt - 2;
        history = new ReplayHistory(cpu);
        history.taken(cpu.snapshotState(), null);
        [stopped, unavailable, showCode] = [true, null, vi.fn()];
        panel = new TracePanel({
            arrangement: new PanelArrangement(() => window.localStorage),
            history: () => history,
            unavailable: () => unavailable,
            stopped: () => stopped,
            nameOf: (address) => (address === LoopAt ? "loop" : undefined),
            showCode,
        });
        panel.setCpu(cpu);
        panel.floating.open();
    }

    /** Runs the machine on, returning each row the trace should show of what it ran. */
    function run(cycles) {
        const ran = [];
        const hook = cpu.debugInstruction.add((pc) => {
            const { a, x, y, s } = cpu;
            const instruction = cpu.disassembler.disassemble(pc, true)[0];
            ran.push({ cycle: cycleCount(cpu), cells: [hexword(pc), pc === LoopAt ? "loop" : "", instruction] });
            ran.at(-1).cells.push(...[a, x, y, s].map(hexbyte), cpu.p.debugString().replace("xx", ""));
        });
        cpu.targetCycles = cpu.currentCycles;
        cpu.execute(cycles);
        hook.remove();
        return ran;
    }

    const status = () => document.querySelector("#trace-panel .trace-status").textContent;
    const rows = () =>
        [...document.querySelectorAll("#trace-panel tbody tr")].map((row) =>
            [...row.children].map((cell) => cell.textContent),
        );

    afterEach(teardownDom);

    it("shows the instructions the machine ran, the newest last, each as it was then with the registers it began with", async () => {
        await counting();
        const ran = run(ManyCycles);
        history.log.record({ kind: "write", address: LoopAt, value: Nop });
        cpu.writemem(LoopAt, Nop);
        await panel.refresh();
        const now = cycleCount(cpu);
        expect(ran.length).toBeGreaterThan(TraceDepth);
        expect(status()).toBe(`The last ${TraceDepth} instructions and interrupts, the newest last.`);
        expect(rows()).toEqual(ran.slice(-TraceDepth).map(({ cycle, cells }) => [`-${now - cycle}`, ...cells]));
        document.querySelector("#trace-panel [data-address]").click();
        expect(showCode).toHaveBeenCalledWith(Number(`0x${rows()[0][1]}`));
    });

    it.each([
        ["the history goes back no further", () => {}, /^\d+ instructions .*: the history goes back no further\.$/],
        [
            "the machine runs",
            () => {
                stopped = false;
            },
            /^Stop the machine in the debugger/,
        ],
        [
            "the page cannot replay",
            () => {
                unavailable = "Not here.";
            },
            /^Not here\.$/,
        ],
    ])("says so where %s", async (_, set, says) => {
        await counting();
        const ran = run(FewCycles);
        set();
        await panel.refresh();
        expect(status()).toMatch(says);
        expect(rows().length).toBe(stopped && !unavailable ? ran.length : 0);
    });
});
