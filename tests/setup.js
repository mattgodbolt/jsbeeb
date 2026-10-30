import { expect, vi } from "vitest";

// Vitest polls every 50 ms by default, and jsdom tests wait on many short-lived conditions.
const PollIntervalMs = 1;

const { waitFor, waitUntil } = vi;
const withFastPolling = (options = {}) =>
    typeof options === "number"
        ? { timeout: options, interval: PollIntervalMs }
        : { interval: PollIntervalMs, ...options };

vi.waitFor = (callback, options) => waitFor(callback, withFastPolling(options));
vi.waitUntil = (callback, options) => waitUntil(callback, withFastPolling(options));

const TypedArray = Object.getPrototypeOf(Int8Array);

// Vitest walks a typed array as a generic iterable, seconds for a machine's memory. Anything else, a pair of
// different element types included, returns undefined and gets Vitest's own comparison.
function typedArraysEqual(a, b) {
    if (!(a instanceof TypedArray) || !(b instanceof TypedArray) || a.constructor !== b.constructor) return undefined;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
}

expect.addEqualityTesters([typedArraysEqual]);
