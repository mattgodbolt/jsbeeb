import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TestMachine } from "../../src/test-machine.js";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
export const RepoRoot = path.resolve(ScriptDir, "../..");
export const OutputDir = path.join(ScriptDir, "output");

// jsdom makes utils.loadData take the browser branch, so back XMLHttpRequest
// with the files the dev server would serve.
export class FileBackedXhr {
    open(_method, url) {
        this._url = url;
    }

    overrideMimeType() {}

    send() {
        const served = path.join(RepoRoot, "public", this._url);
        const file = existsSync(served) ? served : path.join(RepoRoot, this._url);
        try {
            this.response = new Uint8Array(readFileSync(file));
            this.status = 200;
        } catch {
            this.status = 404;
        }
        this.onload();
    }
}

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
