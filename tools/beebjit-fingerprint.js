/** Running beebjit over a disc image, and reading back what it makes of it. */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

const RetryDelayMs = 1000;
const MaxRetries = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the fingerprints out of `beebjit -log disc:fingerprint` output.
 *
 * @param {string} output combined stdout and stderr
 * @returns {{full: ?string, as40: ?string, dfsTitle: ?string, dfsCycle: ?string}[]} one entry per side
 */
export function parseFingerprints(output) {
    const sides = [];
    const at = (index) => {
        if (!sides[index]) sides[index] = { full: null, as40: null, dfsTitle: null, dfsCycle: null };
        return sides[index];
    };
    for (const line of output.split("\n")) {
        const full = /disc side (\d+) CRC32 fingerprint ([0-9A-F]+) title (.*) count ([0-9A-F]+)\s*$/.exec(line);
        if (full) {
            const side = at(Number(full[1]));
            side.full = full[2];
            side.dfsTitle = full[3];
            side.dfsCycle = full[4];
            continue;
        }
        const as40 = /disc side (\d+), as 40 track, CRC32 fingerprint ([0-9A-F]+)\s*$/.exec(line);
        if (as40) at(Number(as40[1])).as40 = as40[2];
    }
    return sides;
}

// Running many beebjits at once turns up two races that have nothing to do
// with the disc: its JIT arena can find the fixed address already occupied,
// and a run this short can trip an assertion on the way out
// (scarybeasts/beebjit#62). Both pass on a retry; a disc that really disagrees
// with the catalogue fails by returning mismatches, not by exiting badly.
export async function runBeebjitWithRetry(beebjitPath, discPath) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await runBeebjit(beebjitPath, discPath);
        } catch (error) {
            if (attempt === MaxRetries) throw error;
            await sleep(RetryDelayMs);
        }
    }
}

const lastLine = (text) => text.trim().split("\n").pop() ?? "";

// beebjit resolves its ROMs relative to the working directory, so run it from
// beside its own binary rather than from wherever the mirror is being built.
export function runBeebjit(beebjitPath, discPath) {
    const args = ["-headless", "-fast", "-cycles", "1", "-log", "disc:fingerprint", "-disc", resolve(discPath)];
    return new Promise((resolve_, reject) => {
        const child = spawn(beebjitPath, args, { stdio: ["ignore", "pipe", "pipe"], cwd: dirname(beebjitPath) });
        let text = "";
        child.stdout.on("data", (chunk) => (text += chunk));
        child.stderr.on("data", (chunk) => (text += chunk));
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code === 0) resolve_(text);
            else reject(new Error(`beebjit ${signal ? `died with ${signal}` : `exited ${code}`}: ${lastLine(text)}`));
        });
    });
}
