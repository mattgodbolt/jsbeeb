"use strict";

import { describe, it, expect, beforeEach } from "vitest";
import { Flags } from "../../src/6502.js";

describe("6502 Tests", () => {
    describe("Flags SaveState", () => {
        let flags;

        beforeEach(() => {
            flags = new Flags();
        });

        it("should initialize flags with defaults", () => {
            expect(flags.c).toBe(false);
            expect(flags.z).toBe(false);
            expect(flags.i).toBe(false);
            expect(flags.d).toBe(false);
            expect(flags.v).toBe(false);
            expect(flags.n).toBe(false);
        });

        it("should save and restore flag state correctly", () => {
            // Set some flags
            flags.c = true;
            flags.z = false;
            flags.i = true;
            flags.d = false;
            flags.v = true;
            flags.n = false;

            // Save state
            const state = flags.saveState();

            // Create a new flags instance and restore
            const newFlags = new Flags();
            newFlags.loadState(state);

            // Check that flags match
            expect(newFlags.c).toBe(true);
            expect(newFlags.z).toBe(false);
            expect(newFlags.i).toBe(true);
            expect(newFlags.d).toBe(false);
            expect(newFlags.v).toBe(true);
            expect(newFlags.n).toBe(false);
        });

        it("should handle all flag combinations", () => {
            // Test all possible combinations (2^6 = 64)
            for (let i = 0; i < 64; i++) {
                flags.c = !!(i & 1);
                flags.z = !!(i & 2);
                flags.i = !!(i & 4);
                flags.d = !!(i & 8);
                flags.v = !!(i & 16);
                flags.n = !!(i & 32);

                const state = flags.saveState();
                const newFlags = new Flags();
                newFlags.loadState(state);

                expect(newFlags.c).toBe(flags.c);
                expect(newFlags.z).toBe(flags.z);
                expect(newFlags.i).toBe(flags.i);
                expect(newFlags.d).toBe(flags.d);
                expect(newFlags.v).toBe(flags.v);
                expect(newFlags.n).toBe(flags.n);
            }
        });

        it("should preserve bit patterns correctly", () => {
            // Set specific bit pattern
            flags._byte = 0x53; // 01010011 - various bits set

            // Save state
            const state = flags.saveState();

            // Create a new flags instance and restore
            const newFlags = new Flags();
            newFlags.loadState(state);

            // Check that raw byte matches
            expect(newFlags._byte).toBe(0x53);

            // And individual flags match what the bit pattern represents
            expect(newFlags.c).toBe(true);
            expect(newFlags.z).toBe(true);
            expect(newFlags.i).toBe(false);
            expect(newFlags.d).toBe(false);
            expect(newFlags.v).toBe(true);
            expect(newFlags.n).toBe(false);
        });
    });

    // Base6502 and Cpu6502 tests can be added here as we implement those components
});
