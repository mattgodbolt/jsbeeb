import { afterEach, describe, expect, it, vi } from "vitest";

import { debounce } from "../../src/debounce.js";

describe("debounce", function () {
    afterEach(function () {
        vi.useRealTimers();
    });

    it("only calls the function once for multiple rapid calls", function () {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = debounce(fn, 100);

        debounced();
        debounced();
        debounced();

        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("uses the arguments from the last call", function () {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = debounce(fn, 100);

        debounced(1);
        debounced(2);
        debounced(3);

        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledWith(3);
    });

    it("resets the timer on each call", function () {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = debounce(fn, 100);

        debounced();
        vi.advanceTimersByTime(50);
        debounced();
        vi.advanceTimersByTime(50);

        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(50);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("preserves the this context", function () {
        vi.useFakeTimers();
        const obj = {
            value: 42,
            getValue: debounce(function () {
                return this.value;
            }, 100),
        };

        let capturedThis;
        const fn = vi.fn(function () {
            capturedThis = this;
        });
        const bound = debounce(fn, 100);
        bound.call(obj);

        vi.advanceTimersByTime(100);
        expect(capturedThis).toBe(obj);
    });
});
