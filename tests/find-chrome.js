// Where the browser tests find a Chrome to drive: CHROME_PATH, else PATH.

import { existsSync } from "node:fs";
import path from "node:path";

const ChromeCandidates = ["google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser"];

let chromePath = null;

/** Look a command up on PATH, as a shell would, without spawning one. */
function onPath(command) {
    // Windows needs the extension supplying; everywhere else the name is whole.
    const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        for (const suffix of suffixes) {
            const candidate = path.join(dir, command + suffix);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

export function findChrome() {
    if (chromePath) return chromePath;
    chromePath = process.env.CHROME_PATH || ChromeCandidates.map(onPath).find(Boolean);
    if (!chromePath)
        throw new Error(
            `No Chrome found on PATH (looked for ${ChromeCandidates.join(", ")}). Install Chrome or ` +
                `Chromium, or set CHROME_PATH to the browser's executable.`,
        );
    return chromePath;
}
