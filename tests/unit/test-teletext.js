"use strict";

import { describe, it, expect, beforeEach } from "vitest";
import { Teletext } from "../../src/teletext.js";
import { SaveState } from "../../src/savestate.js";
import { createMockModel } from "./test-savestate.js";

describe("Teletext Tests", () => {
    let teletext;

    beforeEach(() => {
        teletext = new Teletext();
    });

    describe("SaveState functionality", () => {
        it("should save and restore teletext state", () => {
            // Set up some distinctive state
            teletext.prevCol = 3;
            teletext.col = 5;
            teletext.bg = 1;
            teletext.sep = true;
            teletext.dbl = true;
            teletext.oldDbl = true;
            teletext.secondHalfOfDouble = true;
            teletext.wasDbl = true;
            teletext.gfx = true;
            teletext.flash = true;
            teletext.flashOn = true;
            teletext.flashTime = 42;
            teletext.heldChar = 65; // 'A'
            teletext.holdChar = true;
            teletext.dataQueue = [10, 20, 30, 40];
            teletext.scanlineCounter = 5;
            teletext.levelDEW = true;
            teletext.levelDISPTMG = true;
            teletext.levelRA0 = true;

            // Create a SaveState and save teletext state
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);
            teletext.saveState(saveState);

            // Create a new teletext instance
            const newTeletext = new Teletext();

            // Verify initial state is different
            expect(newTeletext.prevCol).not.toBe(teletext.prevCol);
            expect(newTeletext.col).not.toBe(teletext.col);
            expect(newTeletext.dataQueue).not.toEqual(teletext.dataQueue);

            // Load the saved state
            newTeletext.loadState(saveState);

            // Verify state was restored correctly
            expect(newTeletext.prevCol).toBe(3);
            expect(newTeletext.col).toBe(5);
            expect(newTeletext.bg).toBe(1);
            expect(newTeletext.sep).toBe(true);
            expect(newTeletext.dbl).toBe(true);
            expect(newTeletext.oldDbl).toBe(true);
            expect(newTeletext.secondHalfOfDouble).toBe(true);
            expect(newTeletext.wasDbl).toBe(true);
            expect(newTeletext.gfx).toBe(true);
            expect(newTeletext.flash).toBe(true);
            expect(newTeletext.flashOn).toBe(true);
            expect(newTeletext.flashTime).toBe(42);
            expect(newTeletext.heldChar).toBe(65);
            expect(newTeletext.holdChar).toBe(true);
            expect(newTeletext.dataQueue).toEqual([10, 20, 30, 40]);
            expect(newTeletext.scanlineCounter).toBe(5);
            expect(newTeletext.levelDEW).toBe(true);
            expect(newTeletext.levelDISPTMG).toBe(true);
            expect(newTeletext.levelRA0).toBe(true);
        });

        it("should restore glyph references correctly", () => {
            // Set up glyph references
            teletext.nextGlyphs = teletext.graphicsGlyphs;
            teletext.curGlyphs = teletext.separatedGlyphs;
            teletext.heldGlyphs = teletext.normalGlyphs;

            // Create a save state
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);
            teletext.saveState(saveState);

            // Create a new teletext and restore
            const newTeletext = new Teletext();
            newTeletext.loadState(saveState);

            // Check glyph references are restored
            expect(newTeletext.nextGlyphs === newTeletext.graphicsGlyphs).toBe(true);
            expect(newTeletext.curGlyphs === newTeletext.separatedGlyphs).toBe(true);
            expect(newTeletext.heldGlyphs === newTeletext.normalGlyphs).toBe(true);
        });

        it("should handle empty/default teletext state", () => {
            // Don't modify teletext state, use defaults

            // Create a save state
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);
            teletext.saveState(saveState);

            // Create a new teletext and restore
            const newTeletext = new Teletext();

            // Modify a few values to ensure they get overwritten
            newTeletext.col = 5;
            newTeletext.bg = 2;

            // Load state
            newTeletext.loadState(saveState);

            // Check that values match default teletext state
            expect(newTeletext.col).toBe(7); // Default value
            expect(newTeletext.bg).toBe(0); // Default value
            expect(newTeletext.gfx).toBe(false);
            expect(newTeletext.flash).toBe(false);
        });
    });
});
