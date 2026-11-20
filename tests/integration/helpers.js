import path from "node:path";
import { fileURLToPath } from "node:url";

import { TestMachine } from "../../src/test-machine.js";
import { mode7Text } from "../helpers/mode7-text.js";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
export const RepoRoot = path.resolve(ScriptDir, "../..");
export const OutputDir = path.join(ScriptDir, "output");

export { mode7Text };

const ScreenColumns = 40;

/** The MODE 7 screen's non-blank lines, trimmed. */
export function screenLines(machine) {
    const text = mode7Text(machine);
    const lines = [];
    for (let i = 0; i < text.length; i += ScreenColumns) lines.push(text.slice(i, i + ScreenColumns).trim());
    return lines.filter((line) => line !== "");
}

/** A TestMachine run until the OS waits for keyboard input; undefined arguments take TestMachine's defaults. */
export async function bootedTestMachine(model, options, seconds) {
    const machine = new TestMachine(model, options);
    await machine.initialise();
    await machine.runUntilInput(seconds);
    return machine;
}
