import { describe, expect, it } from "vitest";

import { TestMachine } from "../../src/test-machine.js";
import { mode7Text } from "./helpers.js";

const ScreenColumns = 40;

function screenLines(machine) {
    const text = mode7Text(machine);
    const lines = [];
    for (let i = 0; i < text.length; i += ScreenColumns) lines.push(text.slice(i, i + ScreenColumns).trim());
    return lines.filter((line) => line !== "");
}

describe.each([
    { model: "B-DFS1.2", banner: "BBC Computer 32K" },
    { model: "B-US", banner: "Acorn OS" },
    { model: "B-German", banner: "Acorn OS 32K" },
])("the $model MOS", ({ model, banner }) => {
    it("boots to BASIC with its own banner and runs a line", async () => {
        const machine = new TestMachine(model);
        await machine.initialise();
        await machine.runUntilInput(10);
        expect(screenLines(machine)).toEqual([banner, "Acorn DFS", "BASIC", ">"]);

        await machine.type("PRINT 6*7");
        await machine.runUntilInput(10);
        expect(screenLines(machine).slice(-2)).toEqual(["42", ">"]);
    });
});
