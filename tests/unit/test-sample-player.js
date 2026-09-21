import { describe, it, expect, vi, beforeEach } from "vitest";
import { SamplePlayer } from "../../src/sample-player.js";

function createStubContext(state = "running") {
    return {
        state,
        currentTime: 0,
        createGain() {
            return {
                gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
                connect: vi.fn(),
                disconnect: vi.fn(),
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

    describe("startOneShot", () => {
        it("plays through a gain of its own into the player's, and says when it started", () => {
            context.currentTime = 2.5;
            const player = new SamplePlayer(context, destination, 0.4);
            const playing = player.startOneShot({ duration: 1.0 });
            expect(playing.fade.connect).toHaveBeenCalledWith(player.gain);
            expect(playing.source.connect).toHaveBeenCalledWith(playing.fade);
            expect(playing.source.start).toHaveBeenCalled();
            expect(playing.startedAt).toBe(2.5);
            expect(playing.ended).toBe(false);
            playing.source.onended();
            expect(playing.ended).toBe(true);
            expect(playing.fade.disconnect).toHaveBeenCalled();
            expect(player.playing).toHaveLength(0);
        });

        it("plays nothing when the context is not running", () => {
            context.state = "suspended";
            const player = new SamplePlayer(context, destination, 0.4);
            expect(player.startOneShot({ duration: 1.0 })).toBeNull();
        });
    });

    describe("cutShort", () => {
        it("fades the one-shot out from where it is and stops it a few milliseconds on", () => {
            context.currentTime = 4;
            const player = new SamplePlayer(context, destination, 0.4);
            const playing = player.startOneShot({ duration: 1.0 });
            player.cutShort(playing);
            expect(playing.fade.gain.setValueAtTime).toHaveBeenCalledWith(1, 4);
            const [level, at] = playing.fade.gain.linearRampToValueAtTime.mock.calls[0];
            expect(level).toBe(0);
            expect(at).toBeGreaterThan(4);
            expect(at).toBeLessThan(4.02);
            expect(playing.source.stop).toHaveBeenCalledWith(at);
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
