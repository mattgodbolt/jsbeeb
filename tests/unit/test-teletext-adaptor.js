import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TeletextAdaptor } from "../../src/teletext_adaptor.js";
import * as utils from "../../src/utils.js";

describe("TeletextAdaptor", () => {
    // Constants
    const TELETEXT_IRQ = 5;

    // Mock CPU
    const mockCpu = {
        interrupt: 0,
        resetLine: true,
    };

    let teletext;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        mockCpu.interrupt = 0;
        mockCpu.resetLine = true;

        // Create fresh teletext adaptor
        teletext = new TeletextAdaptor(mockCpu);

        // Silence console logs during tests
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});

        // Override loadChannelStream to avoid actual network calls
        teletext.loadChannelStream = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("Initialization", () => {
        it("should initialize with default state", () => {
            expect(teletext.teletextStatus).toBe(0x0f);
            expect(teletext.teletextInts).toBe(false);
            expect(teletext.teletextEnable).toBe(false);
            expect(teletext.channel).toBe(0);
            expect(teletext.currentFrame).toBe(0);
            expect(teletext.totalFrames).toBe(0);
            expect(teletext.rowPtr).toBe(0);
            expect(teletext.colPtr).toBe(0);
            expect(teletext.frameBuffer.length).toBe(16);
            expect(teletext.frameBuffer[0].length).toBe(64);
            expect(teletext.streamData).toBe(null);
            expect(teletext.pollCount).toBe(0);
        });

        it("should call loadChannelStream on hard reset", () => {
            // Hard reset
            teletext.reset(true);

            // Check if loadChannelStream was called with channel 0
            expect(teletext.loadChannelStream).toHaveBeenCalledWith(0);
        });

        it("should not call loadChannelStream on soft reset", () => {
            // Soft reset
            teletext.reset(false);

            // Check if loadChannelStream was not called
            expect(teletext.loadChannelStream).not.toHaveBeenCalled();
        });
    });

    describe("Register operations", () => {
        describe("Read operations", () => {
            it("should read status register (addr 0)", () => {
                teletext.teletextStatus = 0x42;
                expect(teletext.read(0)).toBe(0x42);
            });

            it("should read row register (addr 1)", () => {
                // Row register reads always return 0
                expect(teletext.read(1)).toBe(0);
            });

            it("should read from frame buffer and increment column pointer (addr 2)", () => {
                // Set up known values in frame buffer
                teletext.rowPtr = 5;
                teletext.colPtr = 10;
                teletext.frameBuffer[5][10] = 0xaa;
                teletext.frameBuffer[5][11] = 0xbb;

                // First read should return value at current position and increment column
                expect(teletext.read(2)).toBe(0xaa);
                expect(teletext.colPtr).toBe(11);

                // Second read should return next value
                expect(teletext.read(2)).toBe(0xbb);
                expect(teletext.colPtr).toBe(12);
            });

            it("should clear status and interrupt on addr 3 read", () => {
                // Set status and interrupt
                teletext.teletextStatus = 0xff;
                mockCpu.interrupt = 1 << TELETEXT_IRQ;

                // Read from addr 3
                teletext.read(3);

                // Status should be cleared (INT, DOR, and FSYN latches)
                expect(teletext.teletextStatus & 0xd0).toBe(0);

                // Interrupt should be cleared
                expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(0);
            });
        });

        describe("Write operations", () => {
            it("should update control bits on status register write (addr 0)", () => {
                // Write with teletext enabled, interrupts enabled, channel 2
                teletext.write(0, 0x0c | 2); // 0x0E

                expect(teletext.teletextEnable).toBe(true);
                expect(teletext.teletextInts).toBe(true);
                expect(teletext.channel).toBe(2);

                // Check if loadChannelStream was called
                expect(teletext.loadChannelStream).toHaveBeenCalledWith(2);
            });

            it("should not reload channel if channel doesn't change", () => {
                // Set initial state
                teletext.channel = 1;
                teletext.teletextEnable = true;

                // Write same channel
                teletext.write(0, 0x0c | 1); // 0x0D

                // Check loadChannelStream wasn't called
                expect(teletext.loadChannelStream).not.toHaveBeenCalled();
            });

            it("should not change channel or load channel if teletext not enabled", () => {
                // Set initial values
                teletext.channel = 1;
                teletext.loadChannelStream.mockClear();

                // Write with teletext disabled, channel 2
                teletext.write(0, 2); // 0x02

                // Teletext should be disabled
                expect(teletext.teletextEnable).toBe(false);

                // Channel should remain unchanged since teletext is disabled
                // According to the implementation in write method, channel is only updated
                // if teletext is enabled: if ((value & 0x03) !== this.channel && this.teletextEnable)
                expect(teletext.channel).toBe(1);

                // Check loadChannelStream wasn't called
                expect(teletext.loadChannelStream).not.toHaveBeenCalled();
            });

            it("should set interrupt flag if INT and interrupts enabled", () => {
                // Set INT latch
                teletext.teletextStatus = 0x80;

                // Enable interrupts
                teletext.write(0, 0x08);

                // Check if interrupt was set
                expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(1 << TELETEXT_IRQ);
            });

            it("should clear interrupt flag if interrupts disabled", () => {
                // Set interrupt
                mockCpu.interrupt = 1 << TELETEXT_IRQ;

                // Disable interrupts
                teletext.write(0, 0x00);

                // Check if interrupt was cleared
                expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(0);
            });

            it("should update row pointer and reset column pointer (addr 1)", () => {
                // Set initial state
                teletext.rowPtr = 0;
                teletext.colPtr = 10;

                // Write to row register
                teletext.write(1, 5);

                expect(teletext.rowPtr).toBe(5);
                expect(teletext.colPtr).toBe(0);
            });

            it("should write to frame buffer and increment column (addr 2)", () => {
                // Set initial position
                teletext.rowPtr = 3;
                teletext.colPtr = 7;

                // Write to data register
                teletext.write(2, 0xaa);

                // Check if value was written and column incremented
                expect(teletext.frameBuffer[3][7]).toBe(0xaa);
                expect(teletext.colPtr).toBe(8);
            });

            it("should clear status and interrupt on addr 3 write", () => {
                // Set status and interrupt
                teletext.teletextStatus = 0xff;
                mockCpu.interrupt = 1 << TELETEXT_IRQ;

                // Write to addr 3
                teletext.write(3, 0);

                // Status should be cleared (INT, DOR, and FSYN latches)
                expect(teletext.teletextStatus & 0xd0).toBe(0);

                // Interrupt should be cleared
                expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(0);
            });
        });
    });

    describe("Channel stream loading", () => {
        const TELETEXT_FRAME_SIZE = 860;

        // Settlers for the fetches the adaptor has started, keyed by the URL it asked for.
        const pending = new Map();
        let adaptor;

        beforeEach(() => {
            pending.clear();
            vi.spyOn(utils, "loadData").mockImplementation(
                (url) => new Promise((resolve, reject) => pending.set(url, { resolve, reject })),
            );
            adaptor = new TeletextAdaptor(mockCpu);
        });

        // Each byte holds the channel number, so the frame buffer shows which stream was applied.
        const resolveChannel = (channel, length = TELETEXT_FRAME_SIZE) =>
            pending.get(`teletext/txt${channel}.dat`).resolve(new Uint8Array(length).fill(channel));

        const failChannel = (channel, error) => pending.get(`teletext/txt${channel}.dat`).reject(error);

        const settle = () => new Promise((resolve) => setTimeout(resolve));

        const listenForNotices = () => {
            const notices = [];
            adaptor.addEventListener("notice", (e) => notices.push(e.detail));
            return notices;
        };

        it("should ignore a response that arrives after a newer channel's", async () => {
            adaptor.write(0, 0x04 | 1); // Teletext enable, channel 1
            adaptor.write(0, 0x04 | 2); // Teletext enable, channel 2

            resolveChannel(2);
            resolveChannel(1);
            await settle();
            adaptor.update();

            expect(adaptor.frameBuffer[0][1]).toBe(2);
        });

        it("should round a truncated stream down to whole frames", async () => {
            adaptor.write(0, 0x04 | 1); // Teletext enable, channel 1

            resolveChannel(1, 2 * TELETEXT_FRAME_SIZE + 100);
            await settle();

            expect(adaptor.totalFrames).toBe(2);
        });

        it("should report a failed load, saying which channel and why", async () => {
            const notices = listenForNotices();

            adaptor.write(0, 0x04 | 1); // Teletext enable, channel 1
            failChannel(1, new Error("http code 404"));
            await settle();

            expect(notices).toHaveLength(1);
            expect(notices[0].message).toContain("channel 1");
            expect(notices[0].message).toContain("http code 404");
        });

        it("should not report a failure from a superseded request", async () => {
            const notices = listenForNotices();

            adaptor.write(0, 0x04 | 1); // Teletext enable, channel 1
            adaptor.write(0, 0x04 | 2); // Teletext enable, channel 2
            failChannel(1, new Error("404"));
            resolveChannel(2);
            await settle();

            expect(notices).toEqual([]);
            expect(adaptor.totalFrames).toBe(1);
        });

        it("should discard a fetch still in flight over a hard reset", async () => {
            adaptor.write(0, 0x04 | 1); // Teletext enable, channel 1
            adaptor.reset(true);

            resolveChannel(0, 3 * TELETEXT_FRAME_SIZE);
            resolveChannel(1, 5 * TELETEXT_FRAME_SIZE);
            await settle();

            expect(adaptor.totalFrames).toBe(3);
        });

        it("should clear state on a hard reset", async () => {
            adaptor.write(0, 0x0c | 1); // Teletext enable, interrupts, channel 1
            resolveChannel(1);
            await settle();
            adaptor.update();
            expect(adaptor.frameBuffer[0][1]).toBe(1);
            expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(1 << TELETEXT_IRQ);

            adaptor.reset(true);

            expect(adaptor.teletextStatus).toBe(0x0f);
            expect(adaptor.teletextEnable).toBe(false);
            expect(adaptor.teletextInts).toBe(false);
            expect(adaptor.channel).toBe(0);
            expect(adaptor.streamData).toBe(null);
            expect(adaptor.totalFrames).toBe(0);
            expect(adaptor.frameBuffer[0][1]).toBe(0);
            expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(0);
        });
    });

    describe("Update and polling", () => {
        it("should update status and frame counter on update()", () => {
            // Set initial state
            teletext.teletextEnable = true;
            teletext.currentFrame = 2;
            teletext.totalFrames = 5;

            // Call update
            teletext.update();

            // Check status latches were set
            expect(teletext.teletextStatus & 0xd0).toBe(0xd0);

            // Check frame was incremented
            expect(teletext.currentFrame).toBe(3);

            // Check pointers were reset
            expect(teletext.rowPtr).toBe(0);
            expect(teletext.colPtr).toBe(0);
        });

        it("should wrap to the start of the stream past the last frame", () => {
            // Past the end of a five frame stream
            teletext.currentFrame = 5;
            teletext.totalFrames = 5;

            // Call update
            teletext.update();

            // Wrapped back to frame 0, which this update then consumed
            expect(teletext.currentFrame).toBe(1);
        });

        it("should tolerate being enabled before the stream has loaded", () => {
            // Teletext enable and interrupts, channel 0
            teletext.write(0, 0x0c);

            teletext.polltime(50001);

            expect(teletext.streamData).toBe(null);
            expect(teletext.teletextStatus & 0xd0).toBe(0xd0);
            expect(teletext.frameBuffer[0][0]).toBe(0);
            expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(1 << TELETEXT_IRQ);
        });

        it("should generate interrupt if interrupts enabled", () => {
            // Enable interrupts
            teletext.teletextInts = true;

            // Clear interrupt
            mockCpu.interrupt = 0;

            // Call update
            teletext.update();

            // Check interrupt was generated
            expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(1 << TELETEXT_IRQ);
        });

        it("should not generate interrupt if interrupts disabled", () => {
            // Disable interrupts
            teletext.teletextInts = false;

            // Clear interrupt
            mockCpu.interrupt = 0;

            // Call update
            teletext.update();

            // Check interrupt wasn't generated
            expect(mockCpu.interrupt & (1 << TELETEXT_IRQ)).toBe(0);
        });

        it("should trigger update when poll cycles exceed threshold", () => {
            // Mock update method
            const updateSpy = vi.spyOn(teletext, "update");

            // Poll with cycles just below threshold (50000)
            teletext.pollCount = 0;
            teletext.polltime(49999);

            // Check update wasn't called
            expect(updateSpy).not.toHaveBeenCalled();

            // Poll with cycles to exceed threshold
            teletext.polltime(2);

            // Check update was called
            expect(updateSpy).toHaveBeenCalled();

            // Check poll count was reset
            expect(teletext.pollCount).toBe(0);
        });

        it("should not update when CPU reset line is low", () => {
            // Set CPU reset line low
            mockCpu.resetLine = false;

            // Mock update method
            const updateSpy = vi.spyOn(teletext, "update");

            // Poll with cycles to exceed threshold
            teletext.pollCount = 0;
            teletext.polltime(50001);

            // Check update wasn't called
            expect(updateSpy).not.toHaveBeenCalled();

            // Check poll count was set to negative value
            expect(teletext.pollCount).toBeLessThan(0);
        });
    });
});
