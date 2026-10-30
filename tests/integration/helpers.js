import path from "node:path";
import { fileURLToPath } from "node:url";

import { TestMachine } from "../../src/test-machine.js";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
export const RepoRoot = path.resolve(ScriptDir, "../..");
export const OutputDir = path.join(ScriptDir, "output");

const Mode7ScreenStart = 0x7c00;
const Mode7ScreenEnd = 0x8000;

/** The mode 7 screen as text, unprintable bytes as spaces. */
export function mode7Text(machine) {
    let text = "";
    for (let addr = Mode7ScreenStart; addr < Mode7ScreenEnd; addr++) {
        const c = machine.readbyte(addr);
        text += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ";
    }
    return text;
}

/** A TestMachine run until the OS waits for keyboard input; undefined arguments take TestMachine's defaults. */
export async function bootedTestMachine(model, options, seconds) {
    const machine = new TestMachine(model, options);
    await machine.initialise();
    await machine.runUntilInput(seconds);
    return machine;
}
