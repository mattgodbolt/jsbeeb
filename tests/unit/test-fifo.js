import { describe, it, expect } from "vitest";

import { Fifo } from "../../src/utils.js";

describe("FIFO tests", function () {
    "use strict";
    it("creates ok", function () {
        new Fifo(16);
    });
    it("works for simple cases", function () {
        const f = new Fifo(16);
        expect(f.size).toBe(0);
        f.put(123);
        expect(f.size).toBe(1);
        expect(f.get()).toBe(123);
        expect(f.size).toBe(0);
    });

    it("works when full", function () {
        const f = new Fifo(4);
        expect(f.size).toBe(0);
        f.put(123);
        f.put(125);
        f.put(126);
        f.put(127);
        expect(f.size).toBe(4);
        f.put(100);
        expect(f.size).toBe(4);
        expect(f.get()).toBe(123);
        expect(f.get()).toBe(125);
        expect(f.get()).toBe(126);
        expect(f.get()).toBe(127);
        expect(f.size).toBe(0);
    });
});
