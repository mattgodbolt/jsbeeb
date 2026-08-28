import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
    Video,
    HDISPENABLE,
    VDISPENABLE,
    USERDISPENABLE,
    EVERYTHINGENABLED,
    OPAQUE_BLACK,
    PalPhasePeriodLines,
} from "../../src/video.js";
import * as utils from "../../src/utils.js";
import { texelsPerPixel } from "../../src/video-filters/pixel-grid.js";
import { decodeLineGrid } from "../line-grid.js";
import { shortestRun } from "../pixel-runs.js";

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
            advance: vi.fn(),
            emit: vi.fn(),
            emitSecondHalf: vi.fn(),
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

        it("should track the logical pixel width for display filters", () => {
            // The ULA's colour bits decide how many framebuffer texels one BBC
            // pixel covers; filters recover the pixel grid from this.
            const widths = [];
            for (const colourBits of [0, 1, 2, 3]) {
                video.ula.write(0, 0x10 | (colourBits << 2));
                widths.push(decodeLineGrid(video.lineGridUla).texelsWide);
            }
            expect(widths).toEqual([8, 4, 2, 1]);
        });

        it("should record the width blitFb actually writes", () => {
            // Asserting the width against the formula would only restate it.
            // Measure what the blitter puts in the framebuffer instead, so a
            // grid that is too narrow is caught as well as one too wide.
            for (let ulaMode = 0; ulaMode <= 3; ++ulaMode) {
                for (const pixelsPerChar of [8, 16]) {
                    video.ulaMode = ulaMode;
                    // Distinct colours per palette entry, so runs are visible.
                    for (let i = 0; i < 16; ++i) video.ulaPal[i] = 0xff000000 | (i * 0x111111);
                    mockFb32.fill(0);
                    // Alternating bits give the shortest runs the mode can make.
                    video.blitFb(0b01010101, 0, pixelsPerChar);

                    expect(shortestRun(mockFb32, 0, pixelsPerChar)).toBe(texelsPerPixel(ulaMode));
                }
            }
        });

        it("should report teletext as one texel per pixel", () => {
            // The SAA5050 writes every texel of its output individually, so
            // MODE 7 is already at the framebuffer's own resolution.
            video.ula.write(0, 0x02);
            expect(decodeLineGrid(video.lineGridUla).texelsWide).toBe(1);
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

        it("should emit pixels in teletext mode", () => {
            // Clear mock history
            mockTeletext.emit.mockClear();

            // Set up horizCounter to avoid vsync logic
            video.horizCounter = 10;

            // Poll to trigger rendering
            video.polltime(1);

            // Verify emit was called with the expected parameters
            expect(mockTeletext.emit).toHaveBeenCalledWith(expect.any(Uint32Array), expect.any(Number));
        });

        it("should clock the SAA5050 but emit nothing in non-teletext mode", () => {
            // Switch to non-teletext mode
            video.ula.write(0, 0);
            expect(video.teletextMode).toBe(false);

            // Clear mock history
            mockTeletext.advance.mockClear();
            mockTeletext.emit.mockClear();

            // Set up horizCounter to avoid vsync logic
            video.horizCounter = 10;

            // Poll to trigger rendering
            video.polltime(1);

            // The chip keeps running whatever the ULA shows, so a control code seen here
            // still takes effect; only its output is switched away.
            // See https://github.com/mattgodbolt/jsbeeb/issues/832
            expect(mockTeletext.advance).toHaveBeenCalled();
            expect(mockTeletext.emit).not.toHaveBeenCalled();
        });

        it("should call fetchData even in non-teletext mode (SAA5050 pipeline always runs)", () => {
            // Switch to non-teletext mode — IC15 still feeds bus data to the SAA5050
            // regardless of ULA mode. See https://github.com/mattgodbolt/jsbeeb/issues/546
            video.ula.write(0, 0);
            expect(video.teletextMode).toBe(false);

            mockTeletext.fetchData.mockClear();
            video.horizCounter = 10;

            video.polltime(1);

            expect(mockTeletext.fetchData).toHaveBeenCalledWith(0x42);
        });

        // IC37/IC36 force bit 6 high during H blanking, so the pipeline sees a graphics character
        // rather than a control code. Gated here on DISPEN; issue #832 says hardware uses MA13.
        it("should force bit 6 high when feeding the pipeline during H blanking", () => {
            mockCpu.videoRead.mockReturnValue(0x05);
            video.dispEnabled = VDISPENABLE;
            mockTeletext.fetchData.mockClear();
            video.horizCounter = 10;

            video.polltime(1);

            expect(mockTeletext.fetchData).toHaveBeenCalledWith(0x45);
        });

        it("should not feed the pipeline outside the vertical display", () => {
            video.dispEnabled = 0;
            mockTeletext.fetchData.mockClear();
            video.horizCounter = 10;

            video.polltime(1);

            expect(mockTeletext.fetchData).not.toHaveBeenCalled();
        });

        // The "TTX trick": with the teletext bit set in a 2MHz mode the ULA holds the SAA5050's
        // DISPEN low, so it outputs black rather than characters.
        it("should draw black instead of characters with the teletext bit set at 2MHz", () => {
            video.ula.write(0, 2 | 0x10);
            expect(video.teletextMode).toBe(true);
            expect(video.halfClock).toBe(false);

            mockTeletext.emit.mockClear();
            video.horizCounter = 10;
            video.bitmapX = 100;
            video.bitmapY = 100;

            video.polltime(1);

            expect(mockTeletext.emit).not.toHaveBeenCalled();
            expect(mockFb32[TEST_FB_OFFSET]).toBe(0xff000000);
        });
    });

    // See Video.repaintSecondHalfOfCell.
    describe("ULA writes half way through a 1MHz cell", () => {
        const Mode4 = 0x88;
        const Mode4Teletext = 0x8a;
        const Mode0 = 0x9c;
        const Red = 0xffff0000;
        const Green = 0xff00ff00;
        const AllPixelsSet = 0xff;
        const CellWidth = 16;
        const HalfCell = 8;
        const inverted = (colour) => (colour ^ 0x00ffffff) >>> 0;
        let offset;

        // Leaves the beam at the start of a cell with the body about to run on the next tick.
        beforeEach(() => {
            video.dispEnabled = EVERYTHINGENABLED;
            video.regs[7] = 30; // keep vsync, and the flyback it brings, away from the cell under test
            video.horizCounter = 10;
            video.bitmapX = 92;
            video.bitmapY = 100;
            video.oddClock = false;
            mockCpu.videoRead.mockReturnValue(AllPixelsSet);
            video.ulaPal.fill(Red);
            offset = 100 * 1024 + 100;
        });

        const cell = () => Array.from(mockFb32.subarray(offset, offset + CellWidth));
        const firstHalf = () => cell().slice(0, HalfCell);
        const secondHalf = () => cell().slice(HalfCell);

        it("repaints the second half as teletext when the teletext bit is set", () => {
            video.ula.write(0, Mode4);
            video.polltime(1);
            expect(cell()).toEqual(Array(CellWidth).fill(Red));

            video.ula.write(0, Mode4Teletext);

            expect(mockTeletext.emitSecondHalf).toHaveBeenCalledWith(expect.any(Uint32Array), offset);
        });

        it("repaints the second half as bitmap when the teletext bit is cleared", () => {
            video.ula.write(0, Mode4Teletext);
            video.polltime(1);
            expect(mockTeletext.emit).toHaveBeenCalledWith(expect.any(Uint32Array), offset);
            expect(cell()).toEqual(Array(CellWidth).fill(OPAQUE_BLACK));

            video.ula.write(0, Mode4);

            expect(firstHalf()).toEqual(Array(HalfCell).fill(OPAQUE_BLACK));
            expect(secondHalf()).toEqual(Array(HalfCell).fill(Red));
        });

        it("applies a palette write to the second half only", () => {
            video.ula.write(0, Mode4);
            video.polltime(1);

            video.ula.write(1, 0xf0 | (7 ^ 2)); // a set pixel in a two colour mode is logical colour 15
            expect(video.ulaPal[15]).toBe(Green);

            expect(firstHalf()).toEqual(Array(HalfCell).fill(Red));
            expect(secondHalf()).toEqual(Array(HalfCell).fill(Green));
        });

        it("leaves the cell alone when the write lands at the start of the next cell", () => {
            video.ula.write(0, Mode4);
            video.polltime(2);
            const before = cell();

            video.ula.write(0, Mode4Teletext);

            expect(cell()).toEqual(before);
            expect(mockTeletext.emitSecondHalf).not.toHaveBeenCalled();
        });

        it("leaves the frame alone while the beam is above it", () => {
            video.ula.write(0, Mode4);
            video.polltime(1);
            video.bitmapY = -1;

            video.ula.write(0, Mode4Teletext);

            expect(mockTeletext.emitSecondHalf).not.toHaveBeenCalled();
        });

        it("leaves a 2MHz mode alone, where every tick already paints", () => {
            video.ula.write(0, Mode0);
            video.polltime(1);
            const before = Array.from(mockFb32.subarray(offset, offset + CellWidth));

            video.ula.write(1, 0xf0 | (7 ^ 2));

            expect(Array.from(mockFb32.subarray(offset, offset + CellWidth))).toEqual(before);
        });

        it("repaints the doubled scanline too", () => {
            video.doubledScanlines = true;
            video.interlacedSyncAndVideo = false;
            video.ula.write(0, Mode4);
            video.polltime(1);
            expect(Array.from(mockFb32.subarray(offset + 1024, offset + 1024 + CellWidth))).toEqual(
                Array(CellWidth).fill(Red),
            );

            video.ula.write(1, 0xf0 | (7 ^ 2));

            expect(Array.from(mockFb32.subarray(offset + 1024 + HalfCell, offset + 1024 + CellWidth))).toEqual(
                Array(HalfCell).fill(Green),
            );
        });

        it("keeps the cursor inverted over the repainted half", () => {
            video.ula.write(0, Mode4 | 0x60); // cursor on both halves of the master cursor table
            video.cursorOnThisFrame = true;
            video.cursorDrawIndex = 3;
            video.polltime(1);
            expect(cell()).toEqual(Array(CellWidth).fill(inverted(Red)));

            video.ula.write(1, 0xf0 | (7 ^ 2));

            expect(firstHalf()).toEqual(Array(HalfCell).fill(inverted(Red)));
            expect(secondHalf()).toEqual(Array(HalfCell).fill(inverted(Green)));
        });
    });

    describe("NULA palette mode", () => {
        it("should use ulaPal (with XOR-7 mapping) when paletteMode is off", () => {
            // Set up Mode 3 (8 pixels, 4 colours per pixel)
            video.ula.write(0, 0x1c); // bits 4+3+2 set = high freq, mode 3

            // Set distinct colours in ulaPal and collook so we can tell which is used
            const ulaColour = 0xffaa0000;
            const nulaDirect = 0xff0000bb;
            video.ulaPal.fill(ulaColour);
            video.ula.collook.fill(nulaDirect);

            // Ensure palette mode is OFF (default)
            expect(video.ula.paletteMode).toBe(0);

            // Render byte 0xFF — all palette indices will be 15
            video.blitFb(0xff, TEST_FB_OFFSET, 8);

            // Should use ulaPal, not collook
            for (let i = 0; i < 8; i++) {
                expect(mockFb32[TEST_FB_OFFSET + i]).toBe(ulaColour);
            }
        });

        it("should use collook directly (bypassing XOR-7) when paletteMode is on", () => {
            video.ula.write(0, 0x1c); // high freq, mode 3

            const ulaColour = 0xffaa0000;
            const nulaDirect = 0xff0000bb;
            video.ulaPal.fill(ulaColour);
            video.ula.collook.fill(nulaDirect);

            // Enable NULA palette mode via control register &FE22
            // Register 1, param 1 => value 0x11
            video.ula.write(2, 0x11);
            expect(video.ula.paletteMode).toBe(1);

            video.blitFb(0xff, TEST_FB_OFFSET, 8);

            // Should use collook directly
            for (let i = 0; i < 8; i++) {
                expect(mockFb32[TEST_FB_OFFSET + i]).toBe(nulaDirect);
            }
        });

        it("should switch back to ulaPal when paletteMode is turned off", () => {
            video.ula.write(0, 0x1c);

            const ulaColour = 0xffaa0000;
            const nulaDirect = 0xff0000bb;
            video.ulaPal.fill(ulaColour);
            video.ula.collook.fill(nulaDirect);

            // Turn palette mode on then off
            video.ula.write(2, 0x11); // on
            video.ula.write(2, 0x10); // off (register 1, param 0)
            expect(video.ula.paletteMode).toBe(0);

            video.blitFb(0xff, TEST_FB_OFFSET, 8);

            for (let i = 0; i < 8; i++) {
                expect(mockFb32[TEST_FB_OFFSET + i]).toBe(ulaColour);
            }
        });

        it("should work correctly in 16-pixel mode with paletteMode on", () => {
            video.ula.write(0, 0x08); // low freq, mode 2

            const nulaDirect = 0xff00cc00;
            video.ula.collook.fill(nulaDirect);

            video.ula.write(2, 0x11); // palette mode on

            video.blitFb(0xff, TEST_FB_OFFSET, 16);

            for (let i = 0; i < 16; i++) {
                expect(mockFb32[TEST_FB_OFFSET + i]).toBe(nulaDirect);
            }
        });

        it("should produce different output with paletteMode on vs off for same data", () => {
            // Mode 3 (4bpp), high freq
            video.ula.write(0, 0x1c);

            // Set collook and ulaPal to completely different colour sets
            for (let i = 0; i < 16; i++) {
                video.ula.collook[i] = 0xff000000 | (i * 17); // dark greys
                video.ulaPal[i] = 0xff000000 | ((15 - i) * 17); // reversed greys
            }

            // Render with palette mode OFF
            video.ula.write(2, 0x10); // palette mode off
            video.blitFb(0xff, TEST_FB_OFFSET, 8);
            const offPixels = Array.from(mockFb32.slice(TEST_FB_OFFSET, TEST_FB_OFFSET + 8));

            // Render with palette mode ON
            video.ula.write(2, 0x11); // palette mode on
            video.blitFb(0xff, TEST_FB_OFFSET, 8);
            const onPixels = Array.from(mockFb32.slice(TEST_FB_OFFSET, TEST_FB_OFFSET + 8));

            // The outputs must differ since collook and ulaPal have different mappings
            expect(onPixels).not.toEqual(offPixels);
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

    // A freshly constructed Video runs a 2MHz character clock, so with
    // R0=127 a scanline is 128 characters of one video clock each.
    const ClocksPerScanline = 128;
    const ScanlinesPerFrame = 312;
    const ClocksPerFrame = ClocksPerScanline * ScanlinesPerFrame;
    const ClocksPerSecond = 2 * 1000 * 1000;

    // Frame-driving tests run millions of video clocks, so they use plain
    // callbacks instead of the shared vi.fn() mocks, which would record every
    // call. `onPaint` sees the video the way main.js's paint callback does.
    function makeVideo(onPaint = () => {}) {
        let paintCount = 0;
        const v = new Video(false, new Uint32Array(1024 * 768), function () {
            paintCount++;
            onPaint(this);
        });
        v.reset({ videoRead: () => 0, interrupt: 0 }, { cb2changecallback: null, setVBlankInt: () => {} });
        const self = {
            video: v,
            paints: () => paintCount,
            resetPaints: () => (paintCount = 0),
            run: (clocks) => v.polltime(clocks),
            writeCrtc: (reg, val) => {
                v.crtc.write(0, reg);
                v.crtc.write(1, val);
            },
            // Aim R7 at the current row for a scanline, the way a program
            // driving vsync from a VIA timer does.
            forceVSync: () => {
                self.writeCrtc(7, 0);
                self.run(ClocksPerScanline);
                self.writeCrtc(7, 0x7f);
            },
        };
        return self;
    }

    function programCommonTiming(v) {
        v.writeCrtc(0, 127); // Horizontal total
        v.writeCrtc(1, 80); // Horizontal displayed
        v.writeCrtc(2, 98); // Hsync position
        v.writeCrtc(3, 0x24); // Sync widths
        v.writeCrtc(5, 0); // Vertical adjust
        v.writeCrtc(6, 32); // Vertical displayed
        v.writeCrtc(8, 0); // No interlace
    }

    function programStandardFrame(v) {
        programCommonTiming(v);
        v.writeCrtc(4, 38); // Vertical total
        v.writeCrtc(7, 34); // Vsync position
        v.writeCrtc(9, 7); // Scanlines per character row
    }

    // R4=0 gives no CRTC-generated vertical structure, so vsync only
    // happens when the program asks for it.
    function programExternallySyncedTiming(v) {
        programCommonTiming(v);
        v.writeCrtc(4, 0); // Vertical total
        v.writeCrtc(9, 0); // One scanline per character row
        v.writeCrtc(7, 0x7f); // Out of reach, so the CRTC never syncs itself
    }

    describe("Painting short frames", () => {
        it("should paint once per frame for a normally programmed display", () => {
            const v = makeVideo();
            programStandardFrame(v);
            v.resetPaints();

            v.run(10 * ClocksPerFrame);

            expect(v.paints()).toBe(10);
        });

        it("should paint once per frame for an R4=0 display synced externally", () => {
            const v = makeVideo();
            programExternallySyncedTiming(v);

            const paintsPerFrame = [];
            for (let frame = 0; frame < 10; ++frame) {
                v.run(ClocksPerFrame - ClocksPerScanline);
                // Count only the paints the vsync itself produces.
                v.resetPaints();
                v.forceVSync();
                paintsPerFrame.push(v.paints());
            }

            expect(paintsPerFrame).toEqual(Array(10).fill(1));
        });

        it("should not paint frames too short to hold a picture", () => {
            const v = makeVideo();
            programExternallySyncedTiming(v);
            v.resetPaints();

            // A vsync every few scanlines, as the boot-up register values give.
            for (let frame = 0; frame < 1000; ++frame) {
                v.run(4 * ClocksPerScanline);
                v.forceVSync();
            }

            expect(v.paints()).toBe(0);
        });

        it("should paint when the beam runs off the bottom without a vsync", () => {
            const v = makeVideo();
            programExternallySyncedTiming(v);
            v.resetPaints();

            v.run(ClocksPerSecond);

            // The beam gives up and flies back every 384 scanlines.
            expect(v.paints()).toBe(Math.floor(ClocksPerSecond / (384 * ClocksPerScanline)));
        });
    });

    describe("PAL line phase", () => {
        // The field parity bookkeeping takes a frame or two to settle after
        // the registers change, as it does on a mode change.
        const SettleFrames = 4;

        const programNonInterlacedFrame = (v) => programStandardFrame(v);

        function programInterlaceSyncFrame(v) {
            programStandardFrame(v);
            v.writeCrtc(8, 1);
        }

        // MODE 7's vertical timing: with interlace sync and video the scanline
        // counter steps by two, so R9 must be even for rows to end at all.
        function programInterlaceSyncAndVideoFrame(v) {
            programCommonTiming(v);
            v.writeCrtc(4, 30); // Vertical total
            v.writeCrtc(5, 2); // Vertical adjust
            v.writeCrtc(6, 25); // Vertical displayed
            v.writeCrtc(7, 27); // Vsync position
            v.writeCrtc(8, 3); // Interlace sync and video
            v.writeCrtc(9, 18); // Scanlines per character row
        }

        // The line bases of each painted frame, read as main.js reads them.
        function paintedBases(program, frames) {
            const bases = [];
            const v = makeVideo((video) => bases.push({ even: video.lineBaseEven, odd: video.lineBaseOdd }));
            program(v);
            v.run(SettleFrames * ClocksPerFrame);
            bases.length = 0;
            v.run(frames * ClocksPerFrame);
            return bases;
        }

        function advances(values) {
            return values.slice(1).map((value, i) => (value - values[i] + PalPhasePeriodLines) % PalPhasePeriodLines);
        }

        // Every painted row must decode to the hsync count it was drawn under,
        // in whichever rows the mode puts a scanline.
        function checkRowsDecodeToTheirLine(program) {
            const drawnUnder = new Map();
            const mismatches = [];
            let paints = 0;
            const v = makeVideo((video) => {
                paints++;
                for (const [row, line] of drawnUnder) {
                    const base = row & 1 ? video.lineBaseOdd : video.lineBaseEven;
                    const decoded = (base + (row >> 1)) % PalPhasePeriodLines;
                    if (decoded !== line) mismatches.push({ row, line, decoded });
                }
            });
            const video = v.video;
            const blitFb = video.blitFb.bind(video);
            video.blitFb = (dat, offset, pixels) => {
                const row = Math.floor(offset / 1024);
                drawnUnder.set(row, video.hsyncCount);
                if (video.doublesLines()) drawnUnder.set(row + 1, video.hsyncCount);
                blitFb(dat, offset, pixels);
            };
            program(v);
            v.run(SettleFrames * ClocksPerFrame);
            drawnUnder.clear();
            mismatches.length = 0;
            paints = 0;
            v.run(6 * ClocksPerFrame);

            expect(paints).toBeGreaterThan(2);
            expect(drawnUnder.size).toBeGreaterThan(200);
            expect(mismatches).toEqual([]);
            return video;
        }

        it("should count hsyncs modulo the phase period", () => {
            const v = makeVideo();
            programStandardFrame(v);
            v.run(10 * ClocksPerFrame);
            expect(v.video.hsyncCount).toBeLessThan(PalPhasePeriodLines);
            expect(v.video.hsyncCount).toBeGreaterThanOrEqual(0);
        });

        it("should advance both bases by a whole frame of lines without interlace", () => {
            const bases = paintedBases(programNonInterlacedFrame, 10);
            expect(bases.map((b) => b.odd)).toEqual(bases.map((b) => b.even));
            expect(advances(bases.map((b) => b.even))).toEqual(Array(9).fill(ScanlinesPerFrame));
            for (const { even } of bases) expect(even).toBeLessThan(PalPhasePeriodLines);
        });

        it("should advance by alternate 312 and 313 line fields with interlace sync", () => {
            const bases = paintedBases(programInterlaceSyncFrame, 8);
            expect(bases.map((b) => b.odd)).toEqual(bases.map((b) => b.even));
            const steps = advances(bases.map((b) => b.even));
            expect(steps.length).toBeGreaterThanOrEqual(6);
            for (let i = 1; i < steps.length; ++i) expect(steps[i - 1] + steps[i]).toBe(625);
            expect(new Set(steps)).toEqual(new Set([312, 313]));
        });

        it("should keep a base per field with interlace sync and video", () => {
            const bases = paintedBases(programInterlaceSyncAndVideoFrame, 8);
            // Each field updates only its own rows' base, so each base changes
            // every other frame and by two fields' worth of lines when it does.
            const changes = (key) => advances(bases.map((b) => b[key]));
            for (const key of ["even", "odd"]) {
                const steps = changes(key);
                expect(steps.length).toBeGreaterThanOrEqual(6);
                for (let i = 1; i < steps.length; ++i) {
                    expect([steps[i - 1], steps[i]].sort()).toEqual([0, 625]);
                }
            }
        });

        it("should decode every row to the line it was drawn under without interlace", () => {
            checkRowsDecodeToTheirLine(programNonInterlacedFrame);
        });

        it("should decode every row to the line it was drawn under with interlace sync", () => {
            checkRowsDecodeToTheirLine(programInterlaceSyncFrame);
        });

        it("should decode every row to the line it was drawn under with interlace sync and video", () => {
            const video = checkRowsDecodeToTheirLine(programInterlaceSyncAndVideoFrame);
            expect(video.lineBaseEven).not.toBe(video.lineBaseOdd);
        });

        it("should decode every row when interlace sync and video is stuck on one field", () => {
            // R6 above R4 stops the frame counter, so every field is drawn
            // doubled onto both rows.
            checkRowsDecodeToTheirLine((v) => {
                programInterlaceSyncAndVideoFrame(v);
                v.writeCrtc(6, 40);
            });
        });
    });

    describe("snapshotState / restoreState", () => {
        // These tests use fresh (non-mocked) Video instances since snapshot
        // needs the real Teletext with snapshotState/restoreState.
        function makeRealVideo() {
            const fb = new Uint32Array(1024 * 768);
            const v = new Video(false, fb, () => {});
            v.reset(mockCpu, mockVia);
            return v;
        }

        it("should snapshot and restore scalar video state", () => {
            const v = makeRealVideo();
            v.bitmapX = 100;
            v.bitmapY = 200;
            v.oddClock = true;
            v.frameCount = 42;
            v.inHSync = true;
            v.inVSync = true;
            v.horizCounter = 63;
            v.vertCounter = 31;
            v.scanlineCounter = 7;
            v.addr = 0x1234;
            v.ulactrl = 0x1c;
            v.ulaMode = 2;
            v.teletextMode = false;
            v.cursorPos = 0x2000;
            v.screenSubtract = 5;

            const snapshot = v.snapshotState();
            const v2 = makeRealVideo();
            v2.restoreState(snapshot);

            expect(v2.bitmapX).toBe(100);
            expect(v2.bitmapY).toBe(200);
            expect(v2.oddClock).toBe(true);
            expect(v2.frameCount).toBe(42);
            expect(v2.inHSync).toBe(true);
            expect(v2.inVSync).toBe(true);
            expect(v2.horizCounter).toBe(63);
            expect(v2.vertCounter).toBe(31);
            expect(v2.scanlineCounter).toBe(7);
            expect(v2.addr).toBe(0x1234);
            expect(v2.ulactrl).toBe(0x1c);
            expect(v2.ulaMode).toBe(2);
            expect(v2.teletextMode).toBe(false);
            expect(v2.cursorPos).toBe(0x2000);
            expect(v2.screenSubtract).toBe(5);
        });

        it("should snapshot and restore the PAL line phase state", () => {
            const v = makeRealVideo();
            v.hsyncCount = 1234;
            v.lineBaseEven = 1000;
            v.lineBaseOdd = 1313;

            const v2 = makeRealVideo();
            v2.restoreState(v.snapshotState());

            expect(v2.hsyncCount).toBe(1234);
            expect(v2.lineBaseEven).toBe(1000);
            expect(v2.lineBaseOdd).toBe(1313);
        });

        it("should restart the PAL line phase from zero for a snapshot without it", () => {
            const v = makeRealVideo();
            const { hsyncCount, lineBaseEven, lineBaseOdd, ...older } = v.snapshotState();
            expect([hsyncCount, lineBaseEven, lineBaseOdd]).toEqual([0, 0, 0]);

            const v2 = makeRealVideo();
            v2.hsyncCount = 99;
            v2.lineBaseEven = 98;
            v2.lineBaseOdd = 97;
            v2.restoreState(older);

            expect([v2.hsyncCount, v2.lineBaseEven, v2.lineBaseOdd]).toEqual([0, 0, 0]);
        });

        it("should rebuild the line grid descriptor on restore", () => {
            // It is derived from ulaMode and teletextMode rather than saved, so
            // a restored machine must not keep the destination's old value.
            const v = makeRealVideo();
            v.ulaMode = 1; // four texels per pixel, as MODE 2 selects
            v.teletextMode = false;

            const v2 = makeRealVideo();
            v2.ulaMode = 3;
            v2.updateLineGridUla();
            v2.restoreState(v.snapshotState());

            expect(decodeLineGrid(v2.lineGridUla).texelsWide).toBe(4);
        });

        it("should snapshot and restore CRTC registers", () => {
            const v = makeRealVideo();
            v.regs[0] = 127;
            v.regs[1] = 80;
            v.regs[6] = 25;
            v.regs[7] = 28;
            v.crtc.curReg = 12;

            const snapshot = v.snapshotState();
            const v2 = makeRealVideo();
            v2.restoreState(snapshot);

            expect(v2.regs[0]).toBe(127);
            expect(v2.regs[1]).toBe(80);
            expect(v2.regs[6]).toBe(25);
            expect(v2.regs[7]).toBe(28);
            expect(v2.crtc.curReg).toBe(12);
        });

        it("should snapshot and restore palette", () => {
            const v = makeRealVideo();
            v.ulaPal[0] = 0xff0000ff;
            v.ulaPal[5] = 0xffff0000;
            v.actualPal[0] = 0x0a;
            v.actualPal[5] = 0x05;

            const snapshot = v.snapshotState();
            const v2 = makeRealVideo();
            v2.restoreState(snapshot);

            expect(v2.ulaPal[0]).toBe(0xff0000ff);
            expect(v2.ulaPal[5]).toBe(0xffff0000);
            expect(v2.actualPal[0]).toBe(0x0a);
            expect(v2.actualPal[5]).toBe(0x05);
        });

        it("should snapshot and restore ULA NULA state", () => {
            const v = makeRealVideo();
            v.ula.paletteMode = 1;
            v.ula.horizontalOffset = 3;
            v.ula.disabled = true;
            v.ula.collook[0] = 0xffaabbcc;

            const snapshot = v.snapshotState();
            const v2 = makeRealVideo();
            v2.restoreState(snapshot);

            expect(v2.ula.paletteMode).toBe(1);
            expect(v2.ula.horizontalOffset).toBe(3);
            expect(v2.ula.disabled).toBe(true);
            expect(v2.ula.collook[0]).toBe(0xffaabbcc);
        });

        it("should snapshot and restore teletext state", () => {
            const v = makeRealVideo();
            v.teletext.col = 3;
            v.teletext.bg = 2;
            v.teletext.gfx = true;
            v.teletext.sep = true;
            v.teletext.flashTime = 32;
            v.teletext.scanlineCounter = 5;

            const snapshot = v.snapshotState();
            const v2 = makeRealVideo();
            v2.restoreState(snapshot);

            expect(v2.teletext.col).toBe(3);
            expect(v2.teletext.bg).toBe(2);
            expect(v2.teletext.gfx).toBe(true);
            expect(v2.teletext.sep).toBe(true);
            expect(v2.teletext.flashTime).toBe(32);
            expect(v2.teletext.scanlineCounter).toBe(5);
        });

        it("should produce isolated snapshots for typed arrays", () => {
            const v = makeRealVideo();
            v.ulaPal[0] = 0xdeadbeef;
            const snapshot = v.snapshotState();
            v.ulaPal[0] = 0x12345678;

            expect(snapshot.ulaPal[0]).toBe(0xdeadbeef);
        });
    });
});
