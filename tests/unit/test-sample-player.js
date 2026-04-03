import { describe, it, expect, vi, beforeEach } from "vitest";
import { SamplePlayer } from "../../src/sample-player.js";

function createStubContext(state = "running") {
    return {
        state,
        createGain() {
            return {
                gain: { value: 1 },
                connect: vi.fn(),
            };
        },
        createBufferSource() {
            return {
                buffer: null,
                loop: false,
                onended: null,
                connect: vi.fn(),
                start: vi.fn(),
                stop: vi.fn(),
            };
        },
    };
}

describe("SamplePlayer", () => {
    let context;
    let destination;

    beforeEach(() => {
        context = createStubContext();
        destination = { isDestination: true };
    });

    describe("constructor", () => {
        it("should create a gain node at the specified volume and connect to destination", () => {
            const player = new SamplePlayer(context, destination, 0.3);
            expect(player.gain.gain.value).toBe(0.3);
            expect(player.gain.connect).toHaveBeenCalledWith(destination);
        });
    });

    describe("mute / unmute", () => {
        it("should set gain to 0 on mute and restore on unmute", () => {
            const player = new SamplePlayer(context, destination, 0.5);
            player.mute();
            expect(player.gain.gain.value).toBe(0);
            player.unmute();
            expect(player.gain.gain.value).toBe(0.5);
        });
    });

    describe("oneShot", () => {
        it("should create a source, connect it, and start playback", () => {
            const player = new SamplePlayer(context, destination, 0.4);
            const fakeBuffer = { duration: 1.5 };
            const duration = player.oneShot(fakeBuffer);
            expect(duration).toBe(1.5);
            // Should have one source in the playing array
            expect(player.playing).toHaveLength(1);
        });

        it("should return duration but not play when context is not running", () => {
            context.state = "suspended";
            const player = new SamplePlayer(context, destination, 0.4);
            const duration = player.oneShot({ duration: 2.0 });
            expect(duration).toBe(2.0);
            expect(player.playing).toHaveLength(0);
        });

        it("should remove source from playing array when ended", () => {
            const player = new SamplePlayer(context, destination, 0.4);
            player.oneShot({ duration: 1.0 });
            expect(player.playing).toHaveLength(1);
            // Simulate the source ending
            const source = player.playing[0];
            source.onended();
            expect(player.playing).toHaveLength(0);
        });
    });

    describe("play", () => {
        it("should reject when context is not running", async () => {
            context.state = "suspended";
            const player = new SamplePlayer(context, destination, 0.4);
            await expect(player.play({ duration: 1.0 })).rejects.toBeUndefined();
        });

        it("should resolve with source when looping", async () => {
            const player = new SamplePlayer(context, destination, 0.4);
            const source = await player.play({ duration: 1.0 }, true);
            expect(source.loop).toBe(true);
            expect(player.playing).toHaveLength(1);
        });

        it("should resolve when non-looping playback ends", async () => {
            const player = new SamplePlayer(context, destination, 0.4);
            const promise = player.play({ duration: 1.0 }, false);
            // Simulate playback ending
            player.playing[0].onended();
            await expect(promise).resolves.toBeUndefined();
            expect(player.playing).toHaveLength(0);
        });
    });
});
