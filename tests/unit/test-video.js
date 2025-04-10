import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Video, HDISPENABLE, VDISPENABLE, USERDISPENABLE, EVERYTHINGENABLED } from "../../src/video.js";
import * as utils from "../../src/utils.js";
import { SaveState } from "../../src/savestate.js";

// Setup the video with imported constants
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
    });

    describe("Memory access in teletext mode", () => {
        beforeEach(() => {
            // Set teletext mode
            video.ula.write(0, 2);
        });

        it("should use correct addressing for Mode 7 on Master", () => {
            // Set up MA13 set (addr bit 13 set) for Mode 7 addressing
            video.addr = 0x2000; // Bit 13 set
            video.isMaster = true; // Set to Master mode

            // Set up CPU to return a specific value
            const expectedData = 0x7f;
            mockCpu.videoRead.mockReturnValue(expectedData);

            // Call readVideoMem which should use chunky addressing mode
            const result = video.readVideoMem();

            // Verify result
            expect(result).toBe(expectedData);

            // Check correct address was used (should mask to 0x3ff and add 0x7c00 for Master)
            expect(mockCpu.videoRead).toHaveBeenCalledWith(0x7c00);
        });

        it("should handle Model B quirk for reading 0x3c00", () => {
            // Set up addr with MA13 set but MA11 clear for Model B quirk
            video.addr = 0x2000; // Bit 13 set, bit 11 clear
            video.isMaster = false; // Set to Model B mode

            // Call readVideoMem
            video.readVideoMem();

            // For Model B, should use 0x3c00 instead of 0x7c00
            expect(mockCpu.videoRead).toHaveBeenCalledWith(0x3c00);
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
            // and it checks if all bits are set with (this.dispEnabled & mask) === mask
            expect(mockTeletext.setDISPTMG).toHaveBeenCalledWith(true);

            // Clear the mock history
            mockTeletext.setDISPTMG.mockClear();

            // Test display enable clear - clear a required flag
            video.dispEnableClear(HDISPENABLE);

            // Now the mask check will fail, so setDISPTMG is called with false
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

            // Triggering vsync is complex, we need to set up more state
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

    describe("SaveState functionality", () => {
        let saveState;

        beforeEach(() => {
            saveState = new SaveState();

            // Set some distinctive values in the video object
            video.frameCount = 42;
            video.oddClock = true;
            video.ulaMode = 2;
            video.teletextMode = true;
            video.cursorPos = 0x3456;

            // Set some CRTC registers
            video.regs[0] = 63;
            video.regs[1] = 40;
            video.regs[2] = 50;
            video.regs[3] = 0x8c;
            video.regs[4] = 38;
            video.regs[5] = 0;
            video.regs[6] = 32;
            video.regs[7] = 34;

            // Set some palette entries
            for (let i = 0; i < 16; i++) {
                video.actualPal[i] = i;
            }
            video.ulactrl = 1; // Enable flash

            // Add teletext saveState functionality to the mock
            mockTeletext.saveState = vi.fn();
            mockTeletext.loadState = vi.fn();
        });

        it("should save video state correctly", () => {
            // Save the state
            video.saveState(saveState);

            // Verify that the state contains the video component
            const storedState = saveState.getComponent("video");
            expect(storedState).toBeDefined();

            // Check that some key properties were saved
            expect(storedState.frameCount).toBe(42);
            expect(storedState.oddClock).toBe(true);
            expect(storedState.ulaMode).toBe(2);
            expect(storedState.teletextMode).toBe(true);
            expect(storedState.cursorPos).toBe(0x3456);

            // Check that CRTC registers were saved
            expect(storedState.regs).toEqual(video.regs);

            // Check that ULA state was saved
            expect(storedState.ulactrl).toBe(1);
            expect(storedState.actualPal).toEqual(video.actualPal);

            // Verify that teletext.saveState was called
            expect(mockTeletext.saveState).toHaveBeenCalledWith(saveState);
        });

        it("should load video state correctly", () => {
            // Save the state first
            video.saveState(saveState);

            // Create a new video instance
            const newFb32 = new Uint32Array(1024 * 768);
            const newPaintExt = vi.fn();
            const newVideo = new Video(false, newFb32, newPaintExt);

            // Replace its teletext with a mock
            newVideo.teletext = {
                saveState: vi.fn(),
                loadState: vi.fn(),
            };

            // Load the state
            newVideo.loadState(saveState);

            // Verify that key properties were restored
            expect(newVideo.frameCount).toBe(42);
            expect(newVideo.oddClock).toBe(true);
            expect(newVideo.ulaMode).toBe(2);
            expect(newVideo.teletextMode).toBe(true);
            expect(newVideo.cursorPos).toBe(0x3456);

            // Check that CRTC registers were restored
            expect(newVideo.regs).toEqual(video.regs);

            // Check that ULA state was restored
            expect(newVideo.ulactrl).toBe(1);
            expect(newVideo.actualPal).toEqual(video.actualPal);

            // Verify that teletext.loadState was called
            expect(newVideo.teletext.loadState).toHaveBeenCalledWith(saveState);
        });

        it("should regenerate ULA palette from actualPal on load", () => {
            // Save the state first
            video.saveState(saveState);

            // Create a new video instance
            const newFb32 = new Uint32Array(1024 * 768);
            const newPaintExt = vi.fn();
            const newVideo = new Video(false, newFb32, newPaintExt);

            // Replace its teletext with a mock
            newVideo.teletext = {
                saveState: vi.fn(),
                loadState: vi.fn(),
            };

            // Spy on ulaPal before loading
            const originalUlaPal = [...newVideo.ulaPal];

            // Load the state
            newVideo.loadState(saveState);

            // Verify that ULA palette was regenerated (should be different from original)
            // At least one value should be different since we set specific values
            let atLeastOneDifferent = false;
            for (let i = 0; i < 16; i++) {
                if (newVideo.ulaPal[i] !== originalUlaPal[i]) {
                    atLeastOneDifferent = true;
                    break;
                }
            }
            expect(atLeastOneDifferent).toBe(true);

            // Verify palette matches what we would expect based on the loaded state
            for (let i = 0; i < 16; i++) {
                // With ulactrl = 1 (flash enabled), colors with bit 3 set are inverted
                const actualPalValue = i; // We set actualPal[i] = i in beforeEach
                const flashEnabled = !!(newVideo.ulactrl & 1);
                let ulaCol = actualPalValue & 7;
                if (!(flashEnabled && actualPalValue & 8)) ulaCol ^= 7;
                expect(newVideo.ulaPal[i]).toBe(newVideo.collook[ulaCol]);
            }
        });
    });
});
