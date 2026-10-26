import { describe, it, expect, beforeEach } from "vitest";
import { SamplePlayer } from "../../src/sample-player.js";
import { stubAudioContext } from "../helpers/stub-audio-context.js";

describe("SamplePlayer", () => {
    let context;
    let destination;

    beforeEach(() => {
        context = stubAudioContext();
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
            expect(player.playing).toHaveLength(1);
        });

        it("should return duration but not play when context is not running", () => {
            context.state = "suspended";
            const player = new SamplePlayer(context, destination, 0.4);
            expect(player.oneShot({ duration: 2.0 })).toBe(2.0);
            expect(player.playing).toHaveLength(0);
        });

        it("frees a source when it ends, leaving the player's own gain connected", () => {
            const player = new SamplePlayer(context, destination, 0.4);
            player.oneShot({ duration: 1.0 });
            player.playing[0].onended();
            expect(player.playing).toEqual([]);
            expect(player.gain.disconnect).not.toHaveBeenCalled();
        });
    });

    describe("startSound", () => {
        it("starts at the time, offset and length asked for, straight into the player's gain", () => {
            const player = new SamplePlayer(context, destination, 0.4);
            const source = player.startSound({ duration: 2 }, { when: 1.5, offset: 0.1, duration: 0.5 });
            expect(source.start).toHaveBeenCalledWith(1.5, 0.1, 0.5);
            expect(source.connect).toHaveBeenCalledWith(player.gain);
            expect(player.playing).toEqual([source]);
        });

        it("plays the rest of the sound when no length is given", () => {
            const player = new SamplePlayer(context, destination, 0.4);
            const source = player.startSound({ duration: 2 }, { offset: 0.3 });
            expect(source.start).toHaveBeenCalledWith(0, 0.3);
        });

        it("fades a cut sound in and out through a gain of its own, freed when it ends", () => {
            const player = new SamplePlayer(context, destination, 0.4);
            const source = player.startSound(
                { duration: 2 },
                { when: 4, offset: 0, duration: 0.024, fadeSeconds: 0.002 },
            );
            const fade = source.connect.mock.calls[0][0];
            expect(fade).not.toBe(player.gain);
            expect(fade.connect).toHaveBeenCalledWith(player.gain);
            expect(fade.gain.setValueAtTime.mock.calls).toEqual([
                [0, 4],
                [1, 4.022],
            ]);
            expect(fade.gain.linearRampToValueAtTime.mock.calls).toEqual([
                [1, 4.002],
                [0, 4.024],
            ]);
            source.onended();
            expect(fade.disconnect).toHaveBeenCalled();
            expect(player.playing).toEqual([]);
        });

        it("plays nothing when the context is not running", () => {
            context.state = "suspended";
            const player = new SamplePlayer(context, destination, 0.4);
            expect(player.startSound({ duration: 2 })).toBeNull();
        });
    });

    describe("stopSound", () => {
        const startCut = (player) =>
            player.startSound({ duration: 2 }, { when: 1, offset: 0, duration: 1, fadeSeconds: 0.002 });

        it("fades a sound out over the fade before the stop, in place of its own fade-out", () => {
            const player = new SamplePlayer(context, destination, 0.4);
            const source = startCut(player);
            const fade = source.connect.mock.calls[0][0];
            player.stopSound(source, 1.5, 0.002);
            expect(fade.gain.cancelScheduledValues).toHaveBeenCalledWith(1.498);
            expect(fade.gain.setValueAtTime).toHaveBeenLastCalledWith(1, 1.498);
            expect(fade.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 1.5);
            expect(source.stop).toHaveBeenCalledWith(1.5);
        });

        it("fades from now when the stop is already past", () => {
            const player = new SamplePlayer(context, destination, 0.4);
            const source = startCut(player);
            context.currentTime = 1.7;
            player.stopSound(source, 1.5, 0.002);
            expect(source.stop).toHaveBeenCalledWith(expect.closeTo(1.702, 9));
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
            player.playing[0].onended();
            await expect(promise).resolves.toBeUndefined();
            expect(player.playing).toHaveLength(0);
        });
    });
});
