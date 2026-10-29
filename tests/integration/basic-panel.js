// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TestMachine } from "../../src/test-machine.js";
import { LanguageRomNumber } from "../../src/basic-state.js";
import { BasicPanel } from "../../src/web/basic-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { PanelKeys } from "../../src/web/panel-keys.js";
import { teardownDom } from "../unit/helpers.js";
import { FileBackedXhr } from "./helpers.js";

const RunCycles = 2 * 1000 * 1000;
const VduDriverStart = 0xc000;
const VduDriverEnd = 0xe000;
const Program = `10 A%=1234:B%=-5:count%=0
20 apple=3.5:Z$="hel:lo"
30 DIM arr%(3),q(2,2)
40 DEF PROCtick:count%=count%+1:ENDPROC
50 FOR I=1 TO 3:PROCtick:NEXT
60 GOTO 50
`;

const text = (selector) => document.querySelector(`#basic-panel ${selector}`).textContent;
const running = () => [text(".basic-line-number"), text(".basic-running")];

describe.each([
    { model: "B-DFS1.2", page: "&1900", otherRom: { number: 14, title: "DFS,NET" } },
    { model: "Master", page: "&0E00", otherRom: { number: 9, title: "DFS" } },
])("the BASIC panel on a running $model", ({ model, page, otherRom }) => {
    let machine;
    let panel;
    let keys;
    let stopsHere;

    beforeEach(async () => {
        vi.stubGlobal("XMLHttpRequest", FileBackedXhr);
        machine = new TestMachine(model);
        await machine.initialise();
        await machine.runUntilInput();
        await machine.loadBasic(Program);
        await machine.type("RUN");
        await machine.runFor(RunCycles);
        const arrangement = new PanelArrangement(() => window.localStorage);
        keys = new PanelKeys(arrangement);
        stopsHere = null;
        panel = new BasicPanel({
            cpu: machine.processor,
            arrangement,
            keys,
            runUntil: (predicate) => (stopsHere = predicate),
            inDebugger: () => true,
        });
        panel.floating.open();
    });

    afterEach(teardownDom);

    /** Runs the run the panel asked for, as the debugger would, until it stops. */
    async function finishRun() {
        await machine.runFor(1);
        const hook = machine.processor.debugInstruction.add(() => stopsHere());
        const stopped = await machine.runFor(RunCycles);
        hook.remove();
        expect(stopped).toBe(true);
        panel.update();
    }

    async function runToLine(number) {
        const input = document.querySelector("#basic-panel .goto-addr");
        input.value = number;
        input.form.requestSubmit();
        await finishRun();
    }

    it("shows where the program and variables are, the resident integers and the dynamic variables", () => {
        expect(text(".basic-pointers")).toMatch(new RegExp(`^PAGE ${page} {2}TOP &[0-9A-F]{4} {2}LOMEM &[0-9A-F]{4}`));
        const residents = [...document.querySelectorAll(".basic-residents span")].map((span) => span.textContent);
        expect(residents.slice(0, 6)).toEqual(["@%", "&0000090A", "A%", "1234", "B%", "-5"]);
        const rows = [...document.querySelectorAll(".basic-variables tr")].map((row) =>
            [...row.cells].map((cell) => cell.textContent),
        );
        expect(rows.map(([name]) => name)).toEqual(["I", "Z$", "apple", "arr%(3)", "count%", "q(2,2)"]);
        expect(Object.fromEntries(rows)).toMatchObject({ Z$: '"hel:lo"', apple: "3.5", "arr%(3)": "" });
        expect(text(".basic-routines")).toBe("PROCtick");
    });

    it("runs to a line, arriving at its first statement or, through a call, at another", async () => {
        await runToLine("60");
        expect(running()).toEqual(["60", " GOTO 50"]);
        await runToLine("40");
        expect(running()).toEqual(["40", "count%=count%+1"]);
        expect(document.querySelector("#basic-panel .basic-line").textContent).toBe(
            "40 DEF PROCtick:count%=count%+1:ENDPROC",
        );
    });

    it("steps a statement at a time with s, into a procedure and out of it", async () => {
        await runToLine("60");
        const steps = [];
        for (let i = 0; i < 5; ++i) {
            expect(keys.press("s")).toBe(true);
            await finishRun();
            steps.push(running());
        }
        expect(steps).toEqual([
            ["50", " FOR I=1 TO 3"],
            ["50", "PROCtick"],
            ["40", "count%=count%+1"],
            ["40", "ENDPROC"],
            ["50", "NEXT"],
        ]);
    });

    it("runs to a line where it is when reached, after the program is edited and run again", async () => {
        machine.keyDown("Escape");
        await machine.runFor(RunCycles / 10);
        machine.keyUp("Escape");
        await machine.runUntilInput();
        const input = document.querySelector("#basic-panel .goto-addr");
        input.value = "60";
        input.form.requestSubmit();
        await machine.type("15 REM a line that moves the rest along");
        await machine.type("RUN");
        await finishRun();
        expect(running()).toEqual(["60", " GOTO 50"]);
    });

    it("marks a line the program does not have, and runs nothing", () => {
        const input = document.querySelector("#basic-panel .goto-addr");
        input.value = "45";
        input.form.requestSubmit();
        expect(input.classList.contains("is-invalid")).toBe(true);
        expect(stopsHere).toBe(null);
    });

    it("says what the language is when it is not BASIC, and shows nothing of BASIC's", () => {
        machine.writebyte(LanguageRomNumber, otherRom.number);
        panel.update();
        expect(text(".basic-absent")).toBe(
            `The current language is ${otherRom.title}, not a BASIC this panel can read.`,
        );
        expect(document.querySelector(".basic-present").hidden).toBe(true);
        expect(document.querySelector("#basic-panel .basic-step").hidden).toBe(true);
        expect(keys.press("s")).toBe(false);
    });
});

describe("the BASIC panel with a second processor", () => {
    afterEach(teardownDom);

    it("says BASIC runs where it cannot read", async () => {
        vi.stubGlobal("XMLHttpRequest", FileBackedXhr);
        const machine = new TestMachine("B-DFS1.2", { tube: true });
        await machine.initialise();
        const arrangement = new PanelArrangement(() => window.localStorage);
        new BasicPanel({
            cpu: machine.processor,
            arrangement,
            keys: new PanelKeys(arrangement),
            runUntil: () => {},
            inDebugger: () => true,
        });
        expect(text(".basic-absent")).toBe(
            "BASIC runs in the second processor, whose memory this panel does not read.",
        );
    });
});

describe("the BASIC panel on a Master in a shadow mode", () => {
    afterEach(teardownDom);

    it("reads memory as BASIC does, even stopped in the VDU driver, which sees the shadow screen", async () => {
        vi.stubGlobal("XMLHttpRequest", FileBackedXhr);
        const machine = new TestMachine("Master");
        await machine.initialise();
        await machine.runUntilInput();
        await machine.loadBasic(`10 MODE 135:LOMEM=&5000
20 apple=3.5
30 PRINT apple:GOTO 30
`);
        await machine.type("RUN");
        await machine.runFor(RunCycles);
        const inVduDriver = machine.processor.debugInstruction.add((pc) => pc >= VduDriverStart && pc < VduDriverEnd);
        expect(await machine.runFor(RunCycles)).toBe(true);
        inVduDriver.remove();
        const arrangement = new PanelArrangement(() => window.localStorage);
        new BasicPanel({
            cpu: machine.processor,
            arrangement,
            keys: new PanelKeys(arrangement),
            runUntil: () => {},
            inDebugger: () => true,
        });
        expect(text(".basic-variables")).toBe("apple3.5");
    });
});
