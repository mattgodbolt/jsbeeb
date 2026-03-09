import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Video } from "../../src/video.js";
import * as utils from "../../src/utils.js";

// Standard BBC Micro colours in ABGR format (matching jsbeeb's collook).
const BbcColours = [
    0xff000000, // 0: black
    0xff0000ff, // 1: red
    0xff00ff00, // 2: green
    0xff00ffff, // 3: yellow
    0xffff0000, // 4: blue
    0xffff00ff, // 5: magenta
    0xffffff00, // 6: cyan
    0xffffffff, // 7: white
];

describe("VideoNula", () => {
    let video;
    let nula;
    let mockFb32;
    let mockPaintExt;

    beforeEach(() => {
        vi.clearAllMocks();
        mockFb32 = new Uint32Array(1024 * 768);
        mockPaintExt = vi.fn();
        vi.spyOn(utils, "makeFast32").mockImplementation((arr) => arr);

        video = new Video(false, mockFb32, mockPaintExt);
        nula = video.nula;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("default palette", () => {
        it("should match standard BBC colours for indices 0–7", () => {
            for (let i = 0; i < 8; i++) {
                expect(nula.collook[i]).toBe(BbcColours[i]);
            }
        });

        it("should duplicate colours 0–7 into indices 8–15", () => {
            for (let i = 0; i < 8; i++) {
                expect(nula.collook[i + 8]).toBe(BbcColours[i]);
            }
        });

        it("should initialise all flash entries to 1 (enabled)", () => {
            for (let i = 0; i < 8; i++) {
                expect(nula.flash[i]).toBe(1);
            }
        });
    });

    describe("2-byte palette write protocol", () => {
        it("should set colour from two consecutive writes to &FE23", () => {
            // Set colour 0 to R=0xF, G=0x0, B=0x0 → pure red.
            // Byte 1: 0x0F = colour 0, red nibble 0xF
            // Byte 2: 0x00 = green 0x0, blue 0x0
            nula.write(0xfe23, 0x0f);
            nula.write(0xfe23, 0x00);

            // R=0xFF, G=0x00, B=0x00 in ABGR = 0xff0000ff
            expect(nula.collook[0]).toBe(0xff0000ff);
        });

        it("should expand 4-bit channels to 8-bit by nibble duplication", () => {
            // Set colour 1 to R=0xA, G=0xB, B=0xC.
            nula.write(0xfe23, 0x1a); // colour 1, red=0xA
            nula.write(0xfe23, 0xbc); // green=0xB, blue=0xC

            // R = 0xAA, G = 0xBB, B = 0xCC → ABGR = 0xff | (CC<<16) | (BB<<8) | AA
            const expected = (0xff000000 | (0xcc << 16) | (0xbb << 8) | 0xaa) >>> 0;
            expect(nula.collook[1]).toBe(expected);
        });

        it("should only commit on the second byte (not the first)", () => {
            const originalColour = nula.collook[2];
            nula.write(0xfe23, 0x2f); // first byte for colour 2
            // Colour should not change yet.
            expect(nula.collook[2]).toBe(originalColour);
        });

        it("should handle all 16 colour indices", () => {
            // Set colour 15 to white (F,F,F).
            nula.write(0xfe23, 0xff); // colour 15, red=0xF
            nula.write(0xfe23, 0xff); // green=0xF, blue=0xF
            expect(nula.collook[15]).toBe(0xffffffff);

            // Set colour 0 to black (0,0,0).
            nula.write(0xfe23, 0x00); // colour 0, red=0x0
            nula.write(0xfe23, 0x00); // green=0x0, blue=0x0
            expect(nula.collook[0]).toBe(0xff000000);
        });

        it("should toggle write flag correctly across multiple writes", () => {
            // Three consecutive writes: first two form a pair, third starts a new pair.
            nula.write(0xfe23, 0x3f); // first byte (colour 3, red=F)
            nula.write(0xfe23, 0xf0); // second byte (green=F, blue=0) → commits
            expect(nula.collook[3]).toBe((0xff000000 | (0x00 << 16) | (0xff << 8) | 0xff) >>> 0); // R=FF,G=FF,B=00

            // Next write is a new first byte — should not change colour 5 yet.
            const before = nula.collook[5];
            nula.write(0xfe23, 0x50);
            expect(nula.collook[5]).toBe(before);
        });
    });

    describe("flash array updates", () => {
        it("should clear flash for colours 8–15 when programmed via palette", () => {
            // Flash starts at 1 for all entries.
            expect(nula.flash[0]).toBe(1);
            expect(nula.flash[4]).toBe(1);

            // Set NULA colour 8 (index 8 → flash[0]).
            nula.write(0xfe23, 0x80);
            nula.write(0xfe23, 0x00);
            expect(nula.flash[0]).toBe(0);

            // Set NULA colour 12 (index 12 → flash[4]).
            nula.write(0xfe23, 0xc0);
            nula.write(0xfe23, 0x00);
            expect(nula.flash[4]).toBe(0);
        });

        it("should not clear flash for colours 0–7 when programmed", () => {
            nula.write(0xfe23, 0x70);
            nula.write(0xfe23, 0x00);
            // flash[7] should remain unchanged (colour 7 < 8, no flash clear).
            expect(nula.flash[7]).toBe(1);
        });

        it("should set flash via control register 8 (colours 0–3)", () => {
            // Reg 8, param = 0b1010 → flash[0]=1, flash[1]=0, flash[2]=1, flash[3]=0
            nula.write(0xfe22, 0x8a);
            expect(nula.flash[0]).toBe(1);
            expect(nula.flash[1]).toBe(0);
            expect(nula.flash[2]).toBe(1);
            expect(nula.flash[3]).toBe(0);
        });

        it("should set flash via control register 9 (colours 4–7)", () => {
            // Reg 9, param = 0b0101 → flash[4]=0, flash[5]=1, flash[6]=0, flash[7]=1
            nula.write(0xfe22, 0x95);
            expect(nula.flash[4]).toBe(0);
            expect(nula.flash[5]).toBe(1);
            expect(nula.flash[6]).toBe(0);
            expect(nula.flash[7]).toBe(1);
        });
    });

    describe("reset (control register 4)", () => {
        it("should restore default palette after custom colours", () => {
            // Set colour 0 to bright red.
            nula.write(0xfe23, 0x0f);
            nula.write(0xfe23, 0x00);
            expect(nula.collook[0]).not.toBe(BbcColours[0]);

            // Reset via control register 4.
            nula.write(0xfe22, 0x40);

            // All colours should match defaults.
            for (let i = 0; i < 16; i++) {
                expect(nula.collook[i]).toBe(BbcColours[i % 8]);
            }
        });

        it("should restore flash to all enabled", () => {
            // Disable some flash entries.
            nula.write(0xfe22, 0x80); // reg 8, param=0 → all flash[0..3]=0
            expect(nula.flash[0]).toBe(0);

            // Reset.
            nula.write(0xfe22, 0x40);

            for (let i = 0; i < 8; i++) {
                expect(nula.flash[i]).toBe(1);
            }
        });

        it("should reset palette write flag", () => {
            // Write one byte (sets the flag).
            nula.write(0xfe23, 0x1f);
            // Reset.
            nula.write(0xfe22, 0x40);
            // Now write a new pair — should require two bytes again.
            nula.write(0xfe23, 0x2f); // first byte
            nula.write(0xfe23, 0x00); // second byte → commits colour 2
            expect(nula.collook[2]).toBe(0xff0000ff); // pure red in ABGR
        });

        it("should clear control register state", () => {
            nula.write(0xfe22, 0x11); // paletteMode = 1
            nula.write(0xfe22, 0x71); // attributeText = 1
            nula.write(0xfe22, 0x40); // reset
            expect(nula.paletteMode).toBe(0);
            expect(nula.attributeText).toBe(0);
        });
    });

    describe("disable (control register 5)", () => {
        it("should redirect &FE22 writes to ULA control (&FE20)", () => {
            // Disable NULA.
            nula.write(0xfe22, 0x50);
            expect(nula.disabled).toBe(true);

            // Write to &FE22 with a value that sets teletext mode (bit 1 of ULA control).
            video.ula.write(0xfe22, 0x02);

            // Should have been treated as a &FE20 write (ULA control register).
            expect(video.teletextMode).toBe(true);
        });

        it("should redirect &FE23 writes to ULA palette (&FE21)", () => {
            nula.write(0xfe22, 0x50);

            // Write to &FE23 with palette value: index 0, colour 7.
            video.ula.write(0xfe23, 0x07);

            // Should have been treated as a &FE21 write (palette register).
            expect(video.actualPal[0]).toBe(7);
        });

        it("should not be cleared by reset", () => {
            nula.write(0xfe22, 0x50);
            nula.reset();
            expect(nula.disabled).toBe(true);
        });
    });

    describe("palette recomputation", () => {
        it("should update ulaPal when a NULA colour changes", () => {
            // Set ULA palette entry 0 to actualPal colour 7 (white in BBC).
            // ULA palette write: index=0, value=7 → actualPal[0]=7, ulaPal[0]=collook[7^7]=collook[0]=black
            video.ula.write(0xfe21, 0x07);
            expect(video.ulaPal[0]).toBe(BbcColours[0]); // black (colour 0 = 7^7)

            // Now change NULA colour 0 to bright green.
            nula.write(0xfe23, 0x00); // colour 0, red=0
            nula.write(0xfe23, 0xf0); // green=F, blue=0 → 0xff00ff00

            // ulaPal[0] should now reflect the new NULA colour 0.
            expect(video.ulaPal[0]).toBe(0xff00ff00);
        });
    });

    describe("control registers", () => {
        it("should set paletteMode via register 1", () => {
            nula.write(0xfe22, 0x11);
            expect(nula.paletteMode).toBe(1);
            nula.write(0xfe22, 0x10);
            expect(nula.paletteMode).toBe(0);
        });

        it("should set horizontalOffset via register 2", () => {
            nula.write(0xfe22, 0x25);
            expect(nula.horizontalOffset).toBe(5);
        });

        it("should set leftBlank via register 3", () => {
            nula.write(0xfe22, 0x3c);
            expect(nula.leftBlank).toBe(12);
        });

        it("should set attributeMode via register 6", () => {
            nula.write(0xfe22, 0x62);
            expect(nula.attributeMode).toBe(2);
        });

        it("should set attributeText via register 7", () => {
            nula.write(0xfe22, 0x71);
            expect(nula.attributeText).toBe(1);
        });
    });

    describe("ULA palette integration with NULA colours", () => {
        it("should use NULA collook for standard ULA palette writes", () => {
            // Change NULA colour 0 (which is collook[0]) to purple.
            // R=0x8, G=0x0, B=0x8 → ABGR = 0xff880088
            nula.write(0xfe23, 0x08); // colour 0, red=8
            nula.write(0xfe23, 0x08); // green=0, blue=8

            const expected = (0xff000000 | (0x88 << 16) | (0x00 << 8) | 0x88) >>> 0;

            // ULA palette write: index 0 → actualPal 7.
            // Non-flash: collook[(7 & 0xf) ^ 7] = collook[0] = our custom purple.
            video.ula.write(0xfe21, 0x07);
            expect(video.ulaPal[0]).toBe(expected);
        });

        it("should handle flash toggle with per-colour NULA flash flags", () => {
            // Disable flash for physical colour 0 (flash[(0 & 7) ^ 7] = flash[7]).
            // Reg 9, param = 0b0110 → flash[4]=0, flash[5]=1, flash[6]=1, flash[7]=0
            nula.write(0xfe22, 0x96);
            expect(nula.flash[7]).toBe(0);

            // Set palette entry 0 to actualPal = 0xF (bit 3 set = flash, colour 7 ^ 7 = 0).
            // With flash[7]=0 (for physical colour (7^7)=0... wait, flash index = (val&7)^7 = 7^7 = 0).
            // Hmm, let me clarify: val=0x0F, val&7=7, flash index=(7)^7=0, flash[0] is still 1.
            // Let's use a different approach: set entry with val&7 = 0, flash[(0)^7]=flash[7]=0.
            video.ula.write(0xfe21, 0x08); // index=0, actualPal=8, colour bits=0
            // Flash enabled globally:
            video.ula.write(0xfe20, 0x01);

            // With flash[7]=0 and palVal=8 (bit 3 set), flash[(0)^7]=flash[7]=0 → no flash override.
            // So ulaPal[0] = collook[(8 & 0xf) ^ 7] = collook[15] = white (default).
            expect(video.ulaPal[0]).toBe(BbcColours[7]); // collook[15] = white
        });
    });
});
