/** What the archive mirror tools share: polite fetching with retries, a worker pool, and their small file helpers. */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { exit, stderr } from "node:process";

const UserAgent = "jsbeeb-mirror (+https://github.com/mattgodbolt/jsbeeb)";
export const DefaultConcurrency = 4;
export const RetryDelayMs = 1000;
const MaxRetries = 3;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} for ${url}`);
        this.status = status;
    }
}

// A dropped connection or a 5xx from an overloaded server is worth retrying. A
// 404 is not: it means an index page promised a file the server won't serve,
// which is a fault to report upstream rather than to retry or work around.
export const isTransient = (error) => !(error instanceof HttpError) || error.status === 429 || error.status >= 500;

/**
 * Fetch `url`, retrying a transient failure up to MaxRetries times, `retryDelayMs` longer apart each time.
 * `waitForTurn`, if given, is awaited before every attempt, to throttle the requests.
 */
export async function fetchWithRetry(url, retryDelayMs, waitForTurn) {
    for (let attempt = 0; ; attempt++) {
        if (waitForTurn) await waitForTurn();
        try {
            const response = await fetch(url, { headers: { "user-agent": UserAgent } });
            if (!response.ok) throw new HttpError(response.status, url);
            return response;
        } catch (error) {
            if (attempt === MaxRetries || !isTransient(error)) throw error;
            await sleep(retryDelayMs * (attempt + 1));
        }
    }
}

// Run `worker` over `items`, at most `concurrency` at a time. The workers share
// one iterator, so each picks up the next item as it finishes.
export async function forEachConcurrently(items, concurrency, progressEvery, worker) {
    const remaining = items.values();
    let done = 0;
    const run = async () => {
        for (const item of remaining) {
            await worker(item);
            if (++done % progressEvery === 0) stderr.write(`  ${done}/${items.length}\n`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

export async function fileSize(path) {
    try {
        return (await stat(path)).size;
    } catch {
        return null;
    }
}

export async function writeJson(dest, value) {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(value, null, 2) + "\n");
}

export function fail(message) {
    stderr.write(`${message}\n`);
    exit(2);
}
