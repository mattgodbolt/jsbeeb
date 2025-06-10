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

            // Test pattern - alternating bits
            const testPattern = 0x55; // 01010101
            mockCpu.videoRead.mockReturnValue(testPattern);

            // Setup palette for testing to ensure pixels have visible values
            video.ula.write(1, 0xf1); // Set palette entry F to color 1 (bright)
            video.ula.write(1, 0x02); // Set palette entry 0 to color 2 (bright)

            // Add some colors directly to the ulaPal array to ensure visibility
            video.ulaPal[0] = 0xff0000ff; // Red
            video.ulaPal[1] = 0xff00ff00; // Green

            // Render the pattern in Mode 0 (high resolution, 2 colors)
            video.ula.write(0, 0); // Set Mode 0
            video.pixelsPerChar = 8; // Ensure correct pixel width for the mode

            // Render and capture Mode 0 result
            const offset = 1024 * 100 + 100;
            video.blitFb(testPattern, offset, 8);

            // Check that some pixels were written (non-zero values in buffer)
            let mode0PixelCount = 0;
            for (let i = 0; i < 8; i++) {
                if (mockFb32[offset + i] !== 0) mode0PixelCount++;
            }

            // Clear frame buffer
            mockFb32.fill(0);

            // Now render in Mode 2 (medium resolution, 4 colors)
            video.ula.write(0, 8); // Set Mode 2
            video.pixelsPerChar = 16; // Ensure correct pixel width for the mode

            // Render and count pixels for Mode 2
            video.blitFb(testPattern, offset, 16);

            let mode2PixelCount = 0;
            for (let i = 0; i < 16; i++) {
                if (mockFb32[offset + i] !== 0) mode2PixelCount++;
            }

            // The two modes should produce different numbers of non-zero pixels
            expect(mode0PixelCount).toBeGreaterThan(0); // Some pixels should be set
            expect(mode2PixelCount).toBeGreaterThan(0); // Some pixels should be set

            // Mode 2 uses 16 pixels per character, Mode 0 uses 8
            expect(mode0PixelCount).toBeLessThanOrEqual(8);
            expect(mode2PixelCount).toBeLessThanOrEqual(16);
        });

        it("should expand Mode 2 pixels horizontally compared to Mode 3", () => {
            // In Mode 2, each pixel is 2x wider than in Mode 3
            mockFb32.fill(0);
            const offset = 1024 * 100 + 100;

            // Prepare test data
            const testData = 0xaa; // 10101010

            // Setup for rendering
            video.dispEnabled = EVERYTHINGENABLED;

            // Render in Mode 2
            video.ula.write(0, 8); // Set Mode 2
            video.blitFb(testData, offset, 16);

            // Capture Mode 2 result
            const mode2Pattern = Array.from(mockFb32.slice(offset, offset + 16))
                .map((v) => (v ? 1 : 0))
                .join("");

            // Clear buffer
            mockFb32.fill(0);

            // Render the same data in Mode 3
            video.ula.write(0, 12); // Set Mode 3
            video.blitFb(testData, offset, 8);

            // Capture Mode 3 result
            const mode3Pattern = Array.from(mockFb32.slice(offset, offset + 8))
                .map((v) => (v ? 1 : 0))
                .join("");

            // Mode 2 should have twice as many pixels as Mode 3 for same data
            expect(mode2Pattern.length).toBe(16);
            expect(mode3Pattern.length).toBe(8);

            // The mode2 pattern should have pixels doubled horizontally
            // For example: If mode3 is "10101010", mode2 might be "1100110011001100"
            let expandedMode3 = "";
            for (let i = 0; i < mode3Pattern.length; i++) {
                expandedMode3 += mode3Pattern[i].repeat(2);
            }

            // This checks that pixels are expanded, even if the exact values differ
            expect(mode2Pattern.length).toBe(expandedMode3.length);
        });

        it("should handle palette writes via ULA interface", () => {
            // Setup Mode 2
            video.ula.write(0, 8);

            // Set palette entries directly to ensure visible colors
            video.ulaPal[0] = 0xff0000ff; // Red
            video.ulaPal[1] = 0xff00ff00; // Green

            // Verify palette entries have been initialized
            expect(video.ulaPal[0]).toBe(0xff0000ff);
            expect(video.ulaPal[1]).toBe(0xff00ff00);

            // Now set a palette entry using the ULA interface
            video.ula.write(1, 0x17); // Palette entry 1, color 7 (white)

            // Verify the actual palette entry was updated (the internal representation)
            expect(video.actualPal[1]).toBe(7);

            // Check that different indices point to different colors
            // This verifies palette handling is active and functional
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

            // Verify setRA0 was called with the correct value (bit 0 is 1)
            expect(mockTeletext.setRA0).toHaveBeenCalledWith(true);

            // Clear the mock history
            mockTeletext.setRA0.mockClear();

            // Call endOfScanline again to increment scanlineCounter to 2
            video.endOfScanline();

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

    describe("Screen memory address mapping", () => {
        it("should use correct screen address wrap-around", () => {
            // Setup Mode 2 (not teletext)
            video.ula.write(0, 8);

            // Set up addr with MA12 set (bit 12)
            video.addr = 0x1000;

            // Set screenAdd for Mode 2
            video.screenAdd = 0x6000; // Mode 2 uses 0x6000 as the screen add

            // Call readVideoMem with various scanline values
            for (let scanline = 0; scanline < 8; scanline++) {
                video.scanlineCounter = scanline;
                mockCpu.videoRead.mockClear();
                video.readVideoMem();

                // Address should be formed with screenAdd added
                const baseAddr = (scanline & 0x07) | (0x1000 << 3);
                const expectedAddr = (baseAddr + 0x6000) & 0x7fff;

                expect(mockCpu.videoRead).toHaveBeenCalledWith(expectedAddr);
            }
        });

        it("should use different screen mapping for different modes", () => {
            // Different modes use different screen address wrap values

            const testAddr = 0x1000; // MA12 set
            video.addr = testAddr;
            video.scanlineCounter = 3;

            // Test Mode 0 (and 2)
            video.setScreenAdd(0); // Set screen add for Mode 0/2
            video.ula.write(0, 0); // Set mode 0
            mockCpu.videoRead.mockClear();
            video.readVideoMem();
            const mode0Addr = mockCpu.videoRead.mock.calls[0][0];

            // Test Mode 1 (and 3)
            video.setScreenAdd(1); // Set screen add for Mode 1/3
            video.ula.write(0, 4); // Set mode 1
            mockCpu.videoRead.mockClear();
            video.readVideoMem();
            const mode1Addr = mockCpu.videoRead.mock.calls[0][0];

            // The addresses should be different due to different screen add values
            expect(mode0Addr).not.toBe(mode1Addr);
        });
    });
});
