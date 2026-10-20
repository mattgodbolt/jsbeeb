import { vi } from "vitest";

// Vitest polls every 50 ms by default, and jsdom tests wait on many short-lived conditions.
const PollIntervalMs = 1;

const { waitFor, waitUntil } = vi;
const withFastPolling = (options = {}) =>
    typeof options === "number"
        ? { timeout: options, interval: PollIntervalMs }
        : { interval: PollIntervalMs, ...options };

vi.waitFor = (callback, options) => waitFor(callback, withFastPolling(options));
vi.waitUntil = (callback, options) => waitUntil(callback, withFastPolling(options));
