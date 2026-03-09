import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Video, HDISPENABLE, VDISPENABLE, USERDISPENABLE, EVERYTHINGENABLED } from "../../src/video.js";
import { Teletext } from "../../src/teletext.js";
import * as utils from "../../src/utils.js";

// Setup with focus on testing behavior rather than implementation details
describe("Video", () => {
    let video;
    let mockCpu;
    let mockVia;
    let mockFb32;
    let mockPaintExt;
    let mockTeletext;

    // Test framebuffer offset at pixel (100, 100) - assumes 1024 pixel width
    const TEST_FB_OFFSET = 1024 * 100 + 100;

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

        // Mock frame buffer
        mockFb32 = new Uint32Array(1024 * 768);

        // Mock CPU with videoRead method
        mockCpu = {
            videoRead: vi.fn().mockReturnValue(0),
            interrupt: 0,
        };

        // Mock VIA with cb2changecallback property
        mockVia = {
            cb2changecallback: null,
            setVBlankInt: vi.fn(),
        };

        // Mock paint_ext function
        mockPaintExt = vi.fn();

        // Spy on utils.makeFast32
        vi.spyOn(utils, "makeFast32").mockImplementation((arr) => arr);

        // Create a video instance (using Model B mode, not Master)
        video = new Video(false, mockFb32, mockPaintExt);

        // Create the mock teletext manually and replace the one in the video object
        mockTeletext = {
            setDEW: vi.fn(),
            setDISPTMG: vi.fn(),
            setRA0: vi.fn(),
            fetchData: vi.fn(),
            render: vi.fn(),
        };

        // Replace the teletext instance
        video.teletext = mockTeletext;

        // Reset and connect CPU and VIA
        video.reset(mockCpu, mockVia);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("ULA control register", () => {
        it("should set teletextMode when bit 1 is set", () => {
            // Initially teletext mode should be false
            expect(video.teletextMode).toBe(false);

            // Write to ULA control register (address 0) with value 2 (bit 1 set)
            video.ula.write(0, 2);

            // Verify teletext mode was set
            expect(video.teletextMode).toBe(true);

            // Clear bit 1
            video.ula.write(0, 0);

            // Verify teletext mode was cleared
            expect(video.teletextMode).toBe(false);
        });

        it("should set correct ulaMode based on bits 2-3", () => {
            // Test mode 0: bits 2-3 = 00
            video.ula.write(0, 0); // 00000000
            expect(video.ulaMode).toBe(0);

            // Test mode 1: bits 2-3 = 01
            video.ula.write(0, 4); // 00000100
            expect(video.ulaMode).toBe(1);

            // Test mode 2: bits 2-3 = 10
            video.ula.write(0, 8); // 00001000
            expect(video.ulaMode).toBe(2);

            // Test mode 3: bits 2-3 = 11
            video.ula.write(0, 12); // 00001100
            expect(video.ulaMode).toBe(3);
        });

        it("should set pixelsPerChar and halfClock based on bit 4", () => {
            // Test with bit 4 clear (default case)
            video.ula.write(0, 0); // 00000000
            expect(video.pixelsPerChar).toBe(16);
            expect(video.halfClock).toBe(true);

            // Test with bit 4 set
            video.ula.write(0, 16); // 00010000
            expect(video.pixelsPerChar).toBe(8);
            expect(video.halfClock).toBe(false);
        });
    });

    describe("Memory addressing", () => {
        it("should use Mode 7 chunky addressing when MA13 is set", () => {
            // Set teletext mode
            video.ula.write(0, 2);
            expect(video.teletextMode).toBe(true);

            // Set up MA13 set (addr bit 13 set)
            video.addr = 0x2000; // Bit 13 set
            video.isMaster = true; // Set to Master mode

            // Set up CPU to return a specific value
            const expectedData = 0x7f;
            mockCpu.videoRead.mockReturnValue(expectedData);

            // Call readVideoMem which should use chunky addressing mode
            const result = video.readVideoMem();

            // Verify result
            expect(result).toBe(expectedData);

            // Check correct address was used for Master
            expect(mockCpu.videoRead).toHaveBeenCalledWith(0x7c00);
        });

        it("should handle Model B quirk for reading 0x3c00 in Mode 7", () => {
            // Set teletext mode
            video.ula.write(0, 2);

            // Set up addr with MA13 set but MA11 clear
            video.addr = 0x2000; // Bit 13 set, bit 11 clear
            video.isMaster = false; // Set to Model B mode

            // Call readVideoMem
            video.readVideoMem();

            // For Model B, should use 0x3c00 instead of 0x7c00
            expect(mockCpu.videoRead).toHaveBeenCalledWith(0x3c00);
        });

        it("should use scanline-based addressing for non-teletext modes", () => {
            // Ensure not in teletext mode
            video.ula.write(0, 0);
            expect(video.teletextMode).toBe(false);

            // Set test values
            video.addr = 0x1234;
            video.scanlineCounter = 5;

            // Call readVideoMem
            video.readVideoMem();

            // Check address formation combines scanline and character address
            const expectedAddr = (5 & 0x07) | (0x1234 << 3);
            expect(mockCpu.videoRead).toHaveBeenCalledWith(expectedAddr & 0x7fff);
        });
    });

    describe("Video mode rendering", () => {
        it("should use different number of pixels per character in different modes", () => {
            // Initialize frame buffer
            mockFb32.fill(0);

            // Setup for rendering
            video.dispEnabled = EVERYTHINGENABLED;

            // Use 0xFF (all bits set) as a simple, predictable test pattern
            const testPattern = 0xff;

            // Setup palette with known colours
            // For 0xFF, the palette index will be 15 (0xF) in all modes
            const testColour = 0xffff0000; // Red
            video.ulaPal.fill(testColour); // Set all palette entries to make test robust

            // Render the pattern in Mode 0 (8 pixels per character)
            video.ula.write(0, 0); // Set Mode 0
            video.pixelsPerChar = 8;

            video.blitFb(testPattern, TEST_FB_OFFSET, 8);

            // Verify all 8 pixels were rendered with the test colour
            for (let i = 0; i < 8; i++) {
                const pixel = mockFb32[TEST_FB_OFFSET + i];
                expect(pixel).toBe(testColour);
            }

            // Clear frame buffer
            mockFb32.fill(0);

            // Now render in Mode 2 (16 pixels per character)
            video.ula.write(0, 8); // Set Mode 2
            video.pixelsPerChar = 16;

            video.blitFb(testPattern, TEST_FB_OFFSET, 16);

            // Verify all 16 pixels were rendered with the test colour
            for (let i = 0; i < 16; i++) {
                const pixel = mockFb32[TEST_FB_OFFSET + i];
                expect(pixel).toBe(testColour);
            }

            // The key difference: Mode 0 renders 8 pixels, Mode 2 renders 16 pixels
            // Both should have all pixels set to the same colour for the 0xFF pattern
        });

        it("should expand Mode 2 pixels horizontally compared to Mode 3", () => {
            // Mode 2 doubles pixels horizontally: each palette index is used for 2 consecutive pixels
            mockFb32.fill(0);

            const testData = 0xaa; // 10101010

            // Setup palette with distinct colours
            video.ulaPal[0] = 0xffff0000; // Red
            video.ulaPal[1] = 0xff00ff00; // Green
            video.ulaPal[2] = 0xff0000ff; // Blue
            video.ulaPal[3] = 0xffffff00; // Yellow

            video.dispEnabled = EVERYTHINGENABLED;

            // Render in Mode 2 (16 pixels)
            video.ula.write(0, 8); // Set Mode 2
            video.blitFb(testData, TEST_FB_OFFSET, 16);

            // Capture Mode 2 result
            const mode2Pixels = Array.from(mockFb32.slice(TEST_FB_OFFSET, TEST_FB_OFFSET + 16));

            // Key property of Mode 2: consecutive pairs of pixels should be identical (doubling)
            for (let i = 0; i < 16; i += 2) {
                expect(mode2Pixels[i]).toBe(mode2Pixels[i + 1]);
            }

            // Clear buffer
            mockFb32.fill(0);

            // Render the same data in Mode 3 (8 pixels)
            video.ula.write(0, 12); // Set Mode 3
            video.blitFb(testData, TEST_FB_OFFSET, 8);

            const mode3Pixels = Array.from(mockFb32.slice(TEST_FB_OFFSET, TEST_FB_OFFSET + 8));

            // Verify that Mode 2's doubled pixels correspond to Mode 3's pixels
            // mode2[0,1] should equal mode3[0], mode2[2,3] should equal mode3[1], etc.
            for (let i = 0; i < 8; i++) {
                expect(mode2Pixels[i * 2]).toBe(mode3Pixels[i]);
                expect(mode2Pixels[i * 2 + 1]).toBe(mode3Pixels[i]);
            }
        });

        it("should handle palette writes via ULA interface", () => {
            // Setup Mode 2
            video.ula.write(0, 8);

            // Set palette entries directly to ensure visible colours
            video.ulaPal[0] = 0xff0000ff; // Blue
            video.ulaPal[1] = 0xff00ff00; // Green

            // Verify palette entries have been initialized
            expect(video.ulaPal[0]).toBe(0xff0000ff);
            expect(video.ulaPal[1]).toBe(0xff00ff00);

            // Now set a palette entry using the ULA interface
            video.ula.write(1, 0x17); // Palette entry 1, colour 7 (white)

            // Verify the actual palette entry was updated to the specific colour
            expect(video.actualPal[1]).toBe(7);

            // Verify that different palette indices have different values
            expect(video.actualPal[0]).not.toBe(video.actualPal[1]);
        });
    });

    describe("Teletext integration", () => {
        beforeEach(() => {
            // Set teletext mode
            video.ula.write(0, 2);
            expect(video.teletextMode).toBe(true);
        });

        it("should call teletext.setDISPTMG when display enable state changes", () => {
            // Clear the teletext mock history
            mockTeletext.setDISPTMG.mockClear();

            // Test display enable set - all required display flags set
            video.dispEnabled = 0;
            video.dispEnableSet(HDISPENABLE | VDISPENABLE | USERDISPENABLE);

            // The mask in dispEnableChanged is HDISPENABLE | VDISPENABLE | USERDISPENABLE
            expect(mockTeletext.setDISPTMG).toHaveBeenCalledWith(true);

            // Clear the mock history
            mockTeletext.setDISPTMG.mockClear();

            // Test display enable clear
            video.dispEnableClear(HDISPENABLE);

            // Now setDISPTMG is called with false
            expect(mockTeletext.setDISPTMG).toHaveBeenCalledWith(false);
        });

        it("should update teletext.setRA0 correctly based on scanlineCounter", () => {
            // Initialize scanlineCounter to 0
            video.scanlineCounter = 0;

            // Clear the mock history
            mockTeletext.setRA0.mockClear();

            // For non-interlaced mode, the RA0 value is just the lowest bit of scanlineCounter
            video.interlacedSyncAndVideo = false;

            // We need to set up the registers to allow endOfScanline to work
            video.regs[9] = 10; // Max scanline number that triggers endOfCharacterLine

            // Call endOfScanline to increment scanlineCounter to 1
            video.endOfScanline();

            // Verify scanlineCounter was incremented
            expect(video.scanlineCounter).toBe(1);

            // Verify setRA0 was called with the correct value (bit 0 is 1)
            expect(mockTeletext.setRA0).toHaveBeenCalledWith(true);

            // Clear the mock history
            mockTeletext.setRA0.mockClear();

            // Call endOfScanline again to increment scanlineCounter to 2
            video.endOfScanline();

            // Verify scanlineCounter was incremented
            expect(video.scanlineCounter).toBe(2);

            // Verify setRA0 was called with the correct value (bit 0 is 0)
            expect(mockTeletext.setRA0).toHaveBeenCalledWith(false);
        });

        it("should handle interlaced RA0 correctly", () => {
            // Set up for interlaced mode
            video.interlacedSyncAndVideo = true;
            video.scanlineCounter = 0;
            video.frameCount = 1; // Odd frame number

            // Initialize registers
            video.regs[9] = 10; // Max scanline number

            // Clear the mock history
            mockTeletext.setRA0.mockClear();

            // Call endOfScanline
            video.endOfScanline();

            // In interlaced mode with odd frame count, externalScanline is scanlineCounter + 1
            // So even though scanlineCounter is now 2 (bit 0 = 0), externalScanline is 3 (bit 0 = 1)
            expect(mockTeletext.setRA0).toHaveBeenCalledWith(true);
        });

        it("should call setDEW when vsync state changes", () => {
            // Setup necessary conditions for vsync
            video.regs[7] = 10; // Vertical sync position
            video.vertCounter = 10;
            video.inVSync = false;
            video.hadVSyncThisRow = false;
            video.horizCounter = 1; // Non-zero to avoid end-of-line logic

            // Clear mock history
            mockTeletext.setDEW.mockClear();

            // Calling polltime with the right conditions
            video.polltime(1);

            // Since we've set up the vertical counter to match R7, vsync should start
            expect(video.inVSync).toBe(true);

            // Verify setDEW was called with the correct parameter
            expect(mockTeletext.setDEW).toHaveBeenCalledWith(true);
        });
    });

    describe("Teletext rendering", () => {
        beforeEach(() => {
            // Set teletext mode
            video.ula.write(0, 2);

            // Set up all display flags to make rendering active
            video.dispEnabled = EVERYTHINGENABLED;

            // Set coords to visible area
            video.bitmapX = 100;
            video.bitmapY = 100;

            // Set test data for video memory
            mockCpu.videoRead.mockReturnValue(0x42);
        });

        it("should call fetchData in teletext mode", () => {
            // Clear mock history
            mockTeletext.fetchData.mockClear();

            // Set up horizCounter to avoid vsync logic
            video.horizCounter = 10;

            // Poll to trigger rendering
            video.polltime(1);

            // Verify fetchData was called with the correct parameter
            expect(mockTeletext.fetchData).toHaveBeenCalledWith(0x42);
        });

        it("should call render in teletext mode", () => {
            // Clear mock history
            mockTeletext.render.mockClear();

            // Set up horizCounter to avoid vsync logic
            video.horizCounter = 10;

            // Poll to trigger rendering
            video.polltime(1);

            // Verify render was called with the expected parameters
            expect(mockTeletext.render).toHaveBeenCalledWith(expect.any(Uint32Array), expect.any(Number));
        });

        it("should not render in non-teletext mode", () => {
            // Switch to non-teletext mode
            video.ula.write(0, 0);
            expect(video.teletextMode).toBe(false);

            // Clear mock history
            mockTeletext.render.mockClear();

            // Set up horizCounter to avoid vsync logic
            video.horizCounter = 10;

            // Poll to trigger rendering
            video.polltime(1);

            // Verify render was not called
            expect(mockTeletext.render).not.toHaveBeenCalled();
        });
    });

    describe("Hardware scrolling address translation", () => {
        beforeEach(() => {
            // Set up for graphics mode (non-teletext)
            video.ula.write(0, 0);
            video.addr = 0x1000; // Set MA12 to trigger translation
            video.scanlineCounter = 0;
        });

        it("should apply mode 0-2 scroll offset (subtract 10)", () => {
            video.setScreenHwScroll(2); // C1=1, C0=0 -> MODE 0-2, subtract 0x5000 (10 from MA11-MA8)
            mockCpu.videoRead.mockReturnValue(0x42);

            const result = video.readVideoMem();

            // MA=0x1000: MA12=1 (trigger), MA11-MA8=0x0, MA7-MA0=0x00
            // adjustedHigh = (0x0 - 10) & 0x0f = 0x6
            // Expected: ((0x6 << 11) | (0x00 << 3) | 0x0) = 0x3000
            // Matches beebjit: (0x1000 * 8) - 0x5000 = 0x8000 - 0x5000 = 0x3000
            expect(mockCpu.videoRead).toHaveBeenCalledWith(0x3000);
            expect(result).toBe(0x42);
        });

        it("should not affect addresses when MA12 is clear", () => {
            video.setScreenHwScroll(2);
            video.addr = 0x0500; // MA12 clear

            video.readVideoMem();

            // No translation: ((0x5 << 11) | (0x00 << 3) | 0x0) = 0x2800
            expect(mockCpu.videoRead).toHaveBeenCalledWith(0x2800);
        });

        it("should handle scanlineCounter offset correctly", () => {
            video.setScreenHwScroll(0); // C1=0, C0=0 -> MODE 3, subtract 0x4000 (8 from MA11-MA8)
            video.addr = 0x1000;
            video.scanlineCounter = 5; // RA = 5

            video.readVideoMem();

            // MA=0x1000: MA12=1 (trigger), MA11-MA8=0x0, MA7-MA0=0x00, RA=5
            // adjustedHigh = (0x0 - 8) & 0x0f = 0x8
            // Expected: ((0x8 << 11) | (0x00 << 3) | 0x5) = 0x4005
            // Matches beebjit: (0x1000 * 8) - 0x4000 + 5 = 0x8000 - 0x4000 + 5 = 0x4005
            expect(mockCpu.videoRead).toHaveBeenCalledWith(0x4005);
        });
    });
});

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

describe("VideoNula (Ula)", () => {
    let video;
    let ula;
    let mockFb32;
    let mockPaintExt;

    beforeEach(() => {
        vi.clearAllMocks();
        mockFb32 = new Uint32Array(1024 * 768);
        mockPaintExt = vi.fn();
        vi.spyOn(utils, "makeFast32").mockImplementation((arr) => arr);

        video = new Video(false, mockFb32, mockPaintExt);
        ula = video.ula;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("default palette", () => {
        it("should match standard BBC colours for indices 0-7", () => {
            for (let i = 0; i < 8; i++) {
                expect(ula.collook[i]).toBe(BbcColours[i]);
            }
        });

        it("should duplicate colours 0-7 into indices 8-15", () => {
            for (let i = 0; i < 8; i++) {
                expect(ula.collook[i + 8]).toBe(BbcColours[i]);
            }
        });

        it("should initialise all flash entries to 1 (enabled)", () => {
            for (let i = 0; i < 8; i++) {
                expect(ula.flash[i]).toBe(1);
            }
        });
    });

    describe("2-byte palette write protocol", () => {
        it("should set colour from two consecutive writes to &FE23", () => {
            // Set colour 0 to R=0xF, G=0x0, B=0x0 -> pure red.
            // Byte 1: 0x0F = colour 0, red nibble 0xF
            // Byte 2: 0x00 = green 0x0, blue 0x0
            ula.write(0xfe23, 0x0f);
            ula.write(0xfe23, 0x00);

            // R=0xFF, G=0x00, B=0x00 in ABGR = 0xff0000ff
            expect(ula.collook[0]).toBe(0xff0000ff);
        });

        it("should expand 4-bit channels to 8-bit by nibble duplication", () => {
            // Set colour 1 to R=0xA, G=0xB, B=0xC.
            ula.write(0xfe23, 0x1a); // colour 1, red=0xA
            ula.write(0xfe23, 0xbc); // green=0xB, blue=0xC

            // R = 0xAA, G = 0xBB, B = 0xCC -> ABGR = 0xff | (CC<<16) | (BB<<8) | AA
            const expected = (0xff000000 | (0xcc << 16) | (0xbb << 8) | 0xaa) >>> 0;
            expect(ula.collook[1]).toBe(expected);
        });

        it("should only commit on the second byte (not the first)", () => {
            const originalColour = ula.collook[2];
            ula.write(0xfe23, 0x2f); // first byte for colour 2
            // Colour should not change yet.
            expect(ula.collook[2]).toBe(originalColour);
        });

        it("should handle all 16 colour indices", () => {
            // Set colour 15 to white (F,F,F).
            ula.write(0xfe23, 0xff); // colour 15, red=0xF
            ula.write(0xfe23, 0xff); // green=0xF, blue=0xF
            expect(ula.collook[15]).toBe(0xffffffff);

            // Set colour 0 to black (0,0,0).
            ula.write(0xfe23, 0x00); // colour 0, red=0x0
            ula.write(0xfe23, 0x00); // green=0x0, blue=0x0
            expect(ula.collook[0]).toBe(0xff000000);
        });

        it("should toggle write flag correctly across multiple writes", () => {
            // Three consecutive writes: first two form a pair, third starts a new pair.
            ula.write(0xfe23, 0x3f); // first byte (colour 3, red=F)
            ula.write(0xfe23, 0xf0); // second byte (green=F, blue=0) -> commits
            expect(ula.collook[3]).toBe((0xff000000 | (0x00 << 16) | (0xff << 8) | 0xff) >>> 0); // R=FF,G=FF,B=00

            // Next write is a new first byte - should not change colour 5 yet.
            const before = ula.collook[5];
            ula.write(0xfe23, 0x50);
            expect(ula.collook[5]).toBe(before);
        });
    });

    describe("flash array updates", () => {
        it("should clear flash for colours 8-15 when programmed via palette", () => {
            // Flash starts at 1 for all entries.
            expect(ula.flash[0]).toBe(1);
            expect(ula.flash[4]).toBe(1);

            // Set NULA colour 8 (index 8 -> flash[0]).
            ula.write(0xfe23, 0x80);
            ula.write(0xfe23, 0x00);
            expect(ula.flash[0]).toBe(0);

            // Set NULA colour 12 (index 12 -> flash[4]).
            ula.write(0xfe23, 0xc0);
            ula.write(0xfe23, 0x00);
            expect(ula.flash[4]).toBe(0);
        });

        it("should not clear flash for colours 0-7 when programmed", () => {
            ula.write(0xfe23, 0x70);
            ula.write(0xfe23, 0x00);
            // flash[7] should remain unchanged (colour 7 < 8, no flash clear).
            expect(ula.flash[7]).toBe(1);
        });

        it("should set flash via control register 8 (colours 0-3)", () => {
            // Reg 8, param = 0b1010 -> flash[0]=1, flash[1]=0, flash[2]=1, flash[3]=0
            ula.write(0xfe22, 0x8a);
            expect(ula.flash[0]).toBe(1);
            expect(ula.flash[1]).toBe(0);
            expect(ula.flash[2]).toBe(1);
            expect(ula.flash[3]).toBe(0);
        });

        it("should set flash via control register 9 (colours 4-7)", () => {
            // Reg 9, param = 0b0101 -> flash[4]=0, flash[5]=1, flash[6]=0, flash[7]=1
            ula.write(0xfe22, 0x95);
            expect(ula.flash[4]).toBe(0);
            expect(ula.flash[5]).toBe(1);
            expect(ula.flash[6]).toBe(0);
            expect(ula.flash[7]).toBe(1);
        });
    });

    describe("reset (control register 4)", () => {
        it("should restore default palette after custom colours", () => {
            // Set colour 0 to bright red.
            ula.write(0xfe23, 0x0f);
            ula.write(0xfe23, 0x00);
            expect(ula.collook[0]).not.toBe(BbcColours[0]);

            // Reset via control register 4.
            ula.write(0xfe22, 0x40);

            // All colours should match defaults.
            for (let i = 0; i < 16; i++) {
                expect(ula.collook[i]).toBe(BbcColours[i % 8]);
            }
        });

        it("should restore flash to all enabled", () => {
            // Disable some flash entries.
            ula.write(0xfe22, 0x80); // reg 8, param=0 -> all flash[0..3]=0
            expect(ula.flash[0]).toBe(0);

            // Reset.
            ula.write(0xfe22, 0x40);

            for (let i = 0; i < 8; i++) {
                expect(ula.flash[i]).toBe(1);
            }
        });

        it("should reset palette write flag", () => {
            // Write one byte (sets the flag).
            ula.write(0xfe23, 0x1f);
            // Reset.
            ula.write(0xfe22, 0x40);
            // Now write a new pair - should require two bytes again.
            ula.write(0xfe23, 0x2f); // first byte
            ula.write(0xfe23, 0x00); // second byte -> commits colour 2
            expect(ula.collook[2]).toBe(0xff0000ff); // pure red in ABGR
        });

        it("should clear control register state", () => {
            ula.write(0xfe22, 0x11); // paletteMode = 1
            ula.write(0xfe22, 0x71); // attributeText = 1
            ula.write(0xfe22, 0x40); // reset
            expect(ula.paletteMode).toBe(0);
            expect(ula.attributeText).toBe(0);
        });

        it("should recompute ulaPal back to BBC defaults", () => {
            // Programme a custom NULA colour and verify ulaPal changed.
            ula.write(0xfe23, 0x00); // colour 0, red=0
            ula.write(0xfe23, 0xf0); // green=F, blue=0 -> bright green 0xff00ff00
            // ULA palette entry 0 maps through collook, so verify it changed.
            const customColour = video.ulaPal[0];
            expect(customColour).not.toBe(BbcColours[0]);

            // Reset via control register 4.
            ula.write(0xfe22, 0x40);

            // ulaPal should now reflect the restored BBC default colours.
            // actualPal[0] defaults to 0, steady colour = collook[(0&0xf)^7] = collook[7] = white.
            expect(video.ulaPal[0]).toBe(BbcColours[7]);
        });
    });

    describe("disable (control register 5)", () => {
        it("should redirect &FE22 writes to ULA control (&FE20)", () => {
            // Disable NULA.
            ula.write(0xfe22, 0x50);
            expect(ula.disabled).toBe(true);

            // Write to &FE22 with a value that sets teletext mode (bit 1 of ULA control).
            video.ula.write(0xfe22, 0x02);

            // Should have been treated as a &FE20 write (ULA control register).
            expect(video.teletextMode).toBe(true);
        });

        it("should redirect &FE23 writes to ULA palette (&FE21)", () => {
            ula.write(0xfe22, 0x50);

            // Write to &FE23 with palette value: index 0, colour 7.
            video.ula.write(0xfe23, 0x07);

            // Should have been treated as a &FE21 write (palette register).
            expect(video.actualPal[0]).toBe(7);
        });

        it("should not be cleared by reset", () => {
            ula.write(0xfe22, 0x50);
            ula.reset();
            expect(ula.disabled).toBe(true);
        });
    });

    describe("palette recomputation", () => {
        it("should update ulaPal when a NULA colour changes", () => {
            // Set ULA palette entry 0 to actualPal colour 7 (white in BBC).
            // ULA palette write: index=0, value=7 -> actualPal[0]=7, ulaPal[0]=collook[7^7]=collook[0]=black
            video.ula.write(0xfe21, 0x07);
            expect(video.ulaPal[0]).toBe(BbcColours[0]); // black (colour 0 = 7^7)

            // Now change NULA colour 0 to bright green.
            ula.write(0xfe23, 0x00); // colour 0, red=0
            ula.write(0xfe23, 0xf0); // green=F, blue=0 -> 0xff00ff00

            // ulaPal[0] should now reflect the new NULA colour 0.
            expect(video.ulaPal[0]).toBe(0xff00ff00);
        });

        it("should recompute ulaPal immediately when flash register 8 is written", () => {
            // Set a palette entry with flash bit set, colour bits = 0.
            // actualPal[0] = 8 (bit 3 = flash), steady colour = collook[(8&0xf)^7] = collook[15].
            ula.write(0xfe21, 0x08);
            expect(video.ulaPal[0]).toBe(ula.collook[15]); // flash off globally

            // Enable global flash.
            ula.write(0xfe20, 0x01);
            // flash[(0)^7]=flash[7] is 1, so flash override applies: collook[8].
            expect(video.ulaPal[0]).toBe(ula.collook[8]);

            // Disable per-colour flash for colour 7 via reg 9 (flash[7]=0).
            // Reg 9, param = 0b0110 -> flash[4]=0, flash[5]=1, flash[6]=1, flash[7]=0
            ula.write(0xfe22, 0x96);

            // ulaPal should update immediately: flash[7]=0 means no flash override.
            expect(video.ulaPal[0]).toBe(ula.collook[15]); // back to steady colour
        });

        it("should recompute ulaPal immediately when flash register 9 is written", () => {
            // Set palette entry 1 with flash bit and colour bits = 4.
            // actualPal[1] = 0xC (bit 3 = flash, colour = 4), flash index = (4)^7 = 3.
            ula.write(0xfe21, 0x1c);
            // Steady colour = collook[(0xC & 0xf) ^ 7] = collook[0xB].
            expect(video.ulaPal[1]).toBe(ula.collook[0x0b]);

            // Enable global flash.
            ula.write(0xfe20, 0x01);
            // flash[3] is 1, so flash override: collook[0xC].
            expect(video.ulaPal[1]).toBe(ula.collook[0x0c]);

            // Disable per-colour flash for colour 3 via reg 8.
            // Reg 8, param = 0b0110 -> flash[0]=0, flash[1]=1, flash[2]=1, flash[3]=0
            ula.write(0xfe22, 0x86);

            // ulaPal should update immediately: flash[3]=0 means no flash override.
            expect(video.ulaPal[1]).toBe(ula.collook[0x0b]); // back to steady colour
        });
    });

    describe("control registers", () => {
        it("should set paletteMode via register 1", () => {
            ula.write(0xfe22, 0x11);
            expect(ula.paletteMode).toBe(1);
            ula.write(0xfe22, 0x10);
            expect(ula.paletteMode).toBe(0);
        });

        it("should set horizontalOffset via register 2", () => {
            ula.write(0xfe22, 0x25);
            expect(ula.horizontalOffset).toBe(5);
        });

        it("should set leftBlank via register 3", () => {
            ula.write(0xfe22, 0x3c);
            expect(ula.leftBlank).toBe(12);
        });

        it("should set attributeMode via register 6", () => {
            ula.write(0xfe22, 0x62);
            expect(ula.attributeMode).toBe(2);
        });

        it("should set attributeText via register 7", () => {
            ula.write(0xfe22, 0x71);
            expect(ula.attributeText).toBe(1);
        });
    });

    describe("ULA palette integration with NULA colours", () => {
        it("should use NULA collook for standard ULA palette writes", () => {
            // Change NULA colour 0 (which is collook[0]) to purple.
            // R=0x8, G=0x0, B=0x8 -> ABGR = 0xff880088
            ula.write(0xfe23, 0x08); // colour 0, red=8
            ula.write(0xfe23, 0x08); // green=0, blue=8

            const expected = (0xff000000 | (0x88 << 16) | (0x00 << 8) | 0x88) >>> 0;

            // ULA palette write: index 0 -> actualPal 7.
            // Non-flash: collook[(7 & 0xf) ^ 7] = collook[0] = our custom purple.
            video.ula.write(0xfe21, 0x07);
            expect(video.ulaPal[0]).toBe(expected);
        });

        it("should handle flash toggle with per-colour NULA flash flags", () => {
            // Disable flash for physical colour 0 (flash[(0 & 7) ^ 7] = flash[7]).
            // Reg 9, param = 0b0110 -> flash[4]=0, flash[5]=1, flash[6]=1, flash[7]=0
            ula.write(0xfe22, 0x96);
            expect(ula.flash[7]).toBe(0);

            // Set palette entry 0 to actualPal = 0xF (bit 3 set = flash, colour 7 ^ 7 = 0).
            // With flash[7]=0 (for physical colour (7^7)=0... wait, flash index = (val&7)^7 = 7^7 = 0).
            // Hmm, let me clarify: val=0x0F, val&7=7, flash index=(7)^7=0, flash[0] is still 1.
            // Let's use a different approach: set entry with val&7 = 0, flash[(0)^7]=flash[7]=0.
            ula.write(0xfe21, 0x08); // index=0, actualPal=8, colour bits=0
            // Flash enabled globally:
            ula.write(0xfe20, 0x01);

            // With flash[7]=0 and palVal=8 (bit 3 set), flash[(0)^7]=flash[7]=0 -> no flash override.
            // So ulaPal[0] = collook[(8 & 0xf) ^ 7] = collook[15] = white (default).
            expect(video.ulaPal[0]).toBe(BbcColours[7]); // collook[15] = white
        });

        it("should recompute flash correctly when ULA control flash bit changes", () => {
            // Set up: palette entry 0 with flash bit set, colour bits = 0.
            // actualPal[0] = 8 (bit 3 = flash), steady colour = collook[(8&0xf)^7] = collook[15].
            ula.write(0xfe21, 0x08);
            expect(video.ulaPal[0]).toBe(ula.collook[15]); // flash off globally, so steady colour

            // Ensure per-colour flash is enabled for this colour (flash[(0)^7] = flash[7]).
            expect(ula.flash[7]).toBe(1);

            // Toggle flash on via ULA control register - this should recompute all palette entries.
            ula.write(0xfe20, 0x01);

            // With flash enabled globally and per-colour flash[7]=1, flash override applies.
            // Flash colour = collook[8 & 0xf] = collook[8].
            expect(video.ulaPal[0]).toBe(ula.collook[8]);

            // Now disable per-colour flash for this colour via NULA control reg 9.
            // Reg 9, param = 0b0110 -> flash[7]=0
            ula.write(0xfe22, 0x96);

            // Toggle flash off and on again to trigger recomputation.
            ula.write(0xfe20, 0x00); // flash off
            ula.write(0xfe20, 0x01); // flash on - recomputes

            // With flash[7]=0, no flash override despite global flash being on.
            expect(video.ulaPal[0]).toBe(ula.collook[15]); // steady colour
        });
    });

    describe("reset clears paletteWriteFlag", () => {
        it("should reset paletteWriteFlag so next palette write starts fresh", () => {
            expect(ula.paletteWriteFlag).toBe(false);

            // Write first byte of a pair (sets the flag).
            ula.write(0xfe23, 0x5f);
            expect(ula.paletteWriteFlag).toBe(true);

            // Reset clears it.
            ula.reset();
            expect(ula.paletteWriteFlag).toBe(false);
        });
    });
});

describe("Teletext rebuildColours", () => {
    let teletext;

    beforeEach(() => {
        teletext = new Teletext();
    });

    it("should produce identical output to init() with BBC default palette", () => {
        // Capture the colour table built by init() (constructor calls init).
        // Note: teletext.colour is an Int32Array (via makeFast32), so copy with matching type.
        const initColours = new Int32Array(teletext.colour);

        // Rebuild with the same BBC default palette.
        const bbcCollook = new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff, 0xff000000,
            0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff,
        ]);
        teletext.rebuildColours(bbcCollook);

        expect(teletext.colour).toEqual(initColours);
    });

    it("should change fg=7/bg=7 entries when colour 7 is set to orange", () => {
        // Orange in ABGR: R=0xFF, G=0x80, B=0x00 -> 0xff0080ff
        const collook = new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xff0080ff, 0xff000000,
            0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xff0080ff,
        ]);
        teletext.rebuildColours(collook);

        // Index for fg=7, bg=7, weight=3 (full foreground): (7<<5)|(7<<2)|3 = 0xFF
        const fullFgIndex = (7 << 5) | (7 << 2) | 3;
        const colour = teletext.colour[fullFgIndex];
        // Should be orange (gamma-corrected, scaled to 240).
        const r = colour & 0xff;
        const g = (colour >> 8) & 0xff;
        const b = (colour >> 16) & 0xff;
        // R channel should be high (near 240), G mid-range, B zero.
        expect(r).toBeGreaterThan(200);
        expect(g).toBeGreaterThan(50);
        expect(g).toBeLessThan(180);
        expect(b).toBe(0);
    });

    it("should return background colour at weight=0", () => {
        // Set fg=1 (red), bg=2 (green), weight=0 -> pure background.
        const collook = new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff, 0xff000000,
            0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff,
        ]);
        teletext.rebuildColours(collook);

        // fg=1, bg=2, weight=0: (2<<5)|(1<<2)|0 = 68
        const index = (2 << 5) | (1 << 2) | 0;
        const colour = teletext.colour[index];
        // Pure bg=2 (green: R=0, G=0xFF, B=0). Gamma-corrected 1.0^(1/2.2)*240 = 240.
        const r = colour & 0xff;
        const g = (colour >> 8) & 0xff;
        expect(r).toBe(0);
        expect(g).toBe(240);
    });

    it("should return foreground colour at weight=3", () => {
        const collook = new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff, 0xff000000,
            0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff,
        ]);
        teletext.rebuildColours(collook);

        // fg=1 (red), bg=2 (green), weight=3: (2<<5)|(1<<2)|3 = 71
        const index = (2 << 5) | (1 << 2) | 3;
        const colour = teletext.colour[index];
        // Pure fg=1 (red: R=0xFF, G=0, B=0). Gamma-corrected: 240.
        const r = colour & 0xff;
        const g = (colour >> 8) & 0xff;
        expect(r).toBe(240);
        expect(g).toBe(0);
    });

    it("should produce solid colour when fg equals bg", () => {
        const collook = new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff, 0xff000000,
            0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff,
        ]);
        teletext.rebuildColours(collook);

        // fg=3 (yellow), bg=3 (yellow) — all 4 weight values should be the same.
        const base = (3 << 5) | (3 << 2);
        const c0 = teletext.colour[base | 0];
        const c1 = teletext.colour[base | 1];
        const c2 = teletext.colour[base | 2];
        const c3 = teletext.colour[base | 3];
        expect(c0).toBe(c1);
        expect(c1).toBe(c2);
        expect(c2).toBe(c3);
    });
});

describe("MODE 7 NULA integration", () => {
    let video;
    let ula;
    let mockFb32;
    let mockPaintExt;

    beforeEach(() => {
        vi.clearAllMocks();
        mockFb32 = new Uint32Array(1024 * 768);
        mockPaintExt = vi.fn();
        vi.spyOn(utils, "makeFast32").mockImplementation((arr) => arr);

        video = new Video(false, mockFb32, mockPaintExt);
        ula = video.ula;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should update teletext colours when NULA palette writes to colours 0-7", () => {
        // Capture teletext colour table before.
        const before = new Uint32Array(video.teletext.colour);

        // Set NULA colour 7 to orange (R=0xF, G=0x8, B=0x0).
        ula.write(0xfe23, 0x7f); // colour 7, red=F
        ula.write(0xfe23, 0x80); // green=8, blue=0

        // Teletext colours should have changed for entries involving colour 7.
        const fullFgIndex = (7 << 5) | (7 << 2) | 3; // fg=7, bg=7, weight=3
        expect(video.teletext.colour[fullFgIndex]).not.toBe(before[fullFgIndex]);
    });

    it("should not update teletext colours when NULA palette writes to colours 8-15", () => {
        const before = new Uint32Array(video.teletext.colour);

        // Set NULA colour 8 (above the base 8 colours).
        ula.write(0xfe23, 0x8f); // colour 8, red=F
        ula.write(0xfe23, 0x00); // green=0, blue=0

        // Teletext colours should be unchanged — only colours 0-7 matter for MODE 7.
        for (let i = 0; i < 256; i++) {
            expect(video.teletext.colour[i]).toBe(before[i]);
        }
    });

    it("should restore teletext colours to BBC defaults on ULA reset", () => {
        // Capture initial teletext colour table.
        const initial = new Uint32Array(video.teletext.colour);

        // Set NULA colour 1 to something different.
        ula.write(0xfe23, 0x1f); // colour 1, red=F
        ula.write(0xfe23, 0xf0); // green=F, blue=0

        // Verify it changed.
        expect(video.teletext.colour).not.toEqual(initial);

        // Reset ULA (via control register 4).
        ula.write(0xfe22, 0x40);

        // Teletext colours should be back to BBC defaults.
        for (let i = 0; i < 256; i++) {
            expect(video.teletext.colour[i]).toBe(initial[i]);
        }
    });
});
