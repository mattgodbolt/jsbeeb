import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Video, HDISPENABLE, VDISPENABLE, USERDISPENABLE, EVERYTHINGENABLED } from "../../src/video.js";
import * as utils from "../../src/utils.js";

// Setup with focus on testing behavior rather than implementation details
describe("Video", () => {
    let video;
    let mockCpu;
    let mockVia;
    let mockFb32;
    let mockPaintExt;
    let mockTeletext;

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
            mockCpu.videoRead.mockReturnValue(testPattern);

            // Setup palette with known colours
            // For 0xFF, the palette index will be 15 (0xF) in all modes
            const testColour = 0xffff0000; // Red
            video.ulaPal.fill(testColour); // Set all palette entries to make test robust

            // Render the pattern in Mode 0 (8 pixels per character)
            video.ula.write(0, 0); // Set Mode 0
            video.pixelsPerChar = 8;

            const offset = 1024 * 100 + 100;
            video.blitFb(testPattern, offset, 8);

            // Verify all 8 pixels were rendered with the test colour
            for (let i = 0; i < 8; i++) {
                const pixel = mockFb32[offset + i];
                expect(pixel).toBe(testColour);
            }

            // Clear frame buffer
            mockFb32.fill(0);

            // Now render in Mode 2 (16 pixels per character)
            video.ula.write(0, 8); // Set Mode 2
            video.pixelsPerChar = 16;

            video.blitFb(testPattern, offset, 16);

            // Verify all 16 pixels were rendered with the test colour
            for (let i = 0; i < 16; i++) {
                const pixel = mockFb32[offset + i];
                expect(pixel).toBe(testColour);
            }

            // The key difference: Mode 0 renders 8 pixels, Mode 2 renders 16 pixels
            // Both should have all pixels set to the same colour for the 0xFF pattern
        });

        it("should expand Mode 2 pixels horizontally compared to Mode 3", () => {
            // Mode 2 doubles pixels horizontally: each palette index is used for 2 consecutive pixels
            mockFb32.fill(0);
            const offset = 1024 * 100 + 100;

            const testData = 0xaa; // 10101010

            // Setup palette with distinct colours
            video.ulaPal[0] = 0xffff0000; // Red
            video.ulaPal[1] = 0xff00ff00; // Green
            video.ulaPal[2] = 0xff0000ff; // Blue
            video.ulaPal[3] = 0xffffff00; // Yellow

            video.dispEnabled = EVERYTHINGENABLED;

            // Render in Mode 2 (16 pixels)
            video.ula.write(0, 8); // Set Mode 2
            video.blitFb(testData, offset, 16);

            // Capture Mode 2 result
            const mode2Pixels = Array.from(mockFb32.slice(offset, offset + 16));

            // Key property of Mode 2: consecutive pairs of pixels should be identical (doubling)
            for (let i = 0; i < 16; i += 2) {
                expect(mode2Pixels[i]).toBe(mode2Pixels[i + 1]);
            }

            // Clear buffer
            mockFb32.fill(0);

            // Render the same data in Mode 3 (8 pixels)
            video.ula.write(0, 12); // Set Mode 3
            video.blitFb(testData, offset, 8);

            const mode3Pixels = Array.from(mockFb32.slice(offset, offset + 8));

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
            video.ulaPal[0] = 0xff0000ff; // Red
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
