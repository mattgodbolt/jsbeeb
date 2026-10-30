import path from "node:path";
import { fileURLToPath } from "node:url";

import { TestMachine } from "../../src/test-machine.js";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
export const RepoRoot = path.resolve(ScriptDir, "../..");
export const OutputDir = path.join(ScriptDir, "output");

export { mode7Text } from "../helpers/mode7-text.js";

/** A TestMachine run until the OS waits for keyboard input; undefined arguments take TestMachine's defaults. */
export async function bootedTestMachine(model, options, seconds) {
    const machine = new TestMachine(model, options);
    await machine.initialise();
    await machine.runUntilInput(seconds);
    return machine;
}
