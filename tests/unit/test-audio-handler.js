// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as bootstrap from "bootstrap";

import { Scheduler } from "../../src/scheduler.js";
import { AudioHandler } from "../../src/web/audio-handler.js";

const SuspendedText = "Your browser has suspended audio";

describe("AudioHandler", () => {
    let contexts;

    function fakeNode() {
        return { connect: () => {}, gain: { value: 0 } };
    }

    function fakeContext(hasWorklet, addModule) {
        return {
            state: "running",
            destination: {},
            audioWorklet: hasWorklet ? { addModule } : undefined,
            createGain: fakeNode,
            resume: async () => {},
        };
    }

    function stubAudio({ hasWorklet = true, addModule = async () => {} } = {}) {
        vi.stubGlobal(
            "AudioContext",
            class {
                constructor(options) {
                    const context = fakeContext(hasWorklet, addModule);
                    context.options = options;
                    contexts.push(context);
                    return context;
                }
            },
        );
        vi.stubGlobal(
            "AudioWorkletNode",
            class {
                constructor(context, name, options) {
                    this.options = options;
                    this.port = { postMessage: () => {}, onmessage: null };
                }
                connect() {}
            },
        );
    }

    function makeHandler(options = {}) {
        return new AudioHandler({
            warningNode: document.getElementById("audio-warning"),
            noSeek: true,
            cpuSpeed: 2000000,
            ...options,
        });
    }

    const warning = () => document.getElementById("audio-warning");
    const warningShown = () => warning().style.display !== "none";

    beforeEach(() => {
        contexts = [];
        document.body.innerHTML = `<div id="audio-warning">${SuspendedText}</div>`;
        vi.stubGlobal("AudioContext", undefined);
        vi.stubGlobal("webkitAudioContext", undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = "";
    });

    describe("without an audio worklet API", () => {
        beforeEach(() => stubAudio({ hasWorklet: false }));

        it("says so in the warning banner", () => {
            makeHandler();

            expect(warningShown()).toBe(true);
            expect(warning().textContent).toContain("No audio worklet API");
        });

        it("leaves the banner up when the audio status is checked", () => {
            const handler = makeHandler();

            handler.checkStatus();

            expect(warningShown()).toBe(true);
        });
    });

    describe("with an audio worklet API", () => {
        beforeEach(() => stubAudio());

        it("starts with no warning", () => {
            makeHandler();

            expect(warningShown()).toBe(false);
            expect(warning().textContent).toContain(SuspendedText);
        });

        it("warns while the audio is suspended", () => {
            const handler = makeHandler();

            for (const context of contexts) context.state = "suspended";
            handler.checkStatus();

            expect(warningShown()).toBe(true);
            expect(warning().textContent).toContain(SuspendedText);
        });

        it("ships the chip's writes with the emulator's position on flush", async () => {
            const handler = makeHandler();
            await vi.waitFor(() => expect(handler._jsAudioNode).not.toBeNull());
            const posted = vi.spyOn(handler._jsAudioNode.port, "postMessage");

            handler.soundChip.scheduler.epoch = 5000;
            handler.soundChip.poke(0x8d);
            handler.flushChipEvents();
            handler.flushChipEvents();

            expect(posted.mock.calls.map((call) => call[0])).toEqual([
                { upTo: 5000, events: [{ cycle: 5000, poke: 0x8d }] },
                { upTo: 5000, events: [] },
            ]);
        });

        it("ships events as the emulation progresses, not only at the end of a tick", async () => {
            const handler = makeHandler();
            await vi.waitFor(() => expect(handler._jsAudioNode).not.toBeNull());
            const scheduler = new Scheduler();
            handler.soundChip.setScheduler(scheduler);
            const posted = vi.spyOn(handler._jsAudioNode.port, "postMessage");

            handler.soundChip.poke(0x8d);
            scheduler.polltime(4000);

            expect(posted.mock.calls.map((call) => call[0])).toEqual([
                { upTo: 4000, events: [{ cycle: 0, poke: 0x8d }] },
            ]);
        });

        it("ships a mute at once, since the stopped emulator will not tick", async () => {
            const handler = makeHandler();
            await vi.waitFor(() => expect(handler._jsAudioNode).not.toBeNull());
            const posted = vi.spyOn(handler._jsAudioNode.port, "postMessage");

            handler.mute();
            handler.unmute();

            expect(posted.mock.calls.map((call) => call[0].events)).toEqual([
                [{ cycle: 0, enabled: false }],
                [{ cycle: 0, enabled: true }],
            ]);
        });

        it("hands the output filter settings to the worklet", async () => {
            const handler = makeHandler({ audioFilterFreq: 1234, audioFilterQ: 0.5 });
            await vi.waitFor(() => expect(handler._jsAudioNode).not.toBeNull());

            expect(handler._jsAudioNode.options.processorOptions).toMatchObject({
                audioFilterFreq: 1234,
                audioFilterQ: 0.5,
            });
        });

        it("creates no Music 5000 audio context unless one is fitted", () => {
            makeHandler();

            expect(contexts).toHaveLength(1);
        });

        it("creates a Music 5000 audio context at the board's sample rate when one is fitted", () => {
            makeHandler({ hasMusic5000: true });

            expect(contexts).toHaveLength(2);
            expect(contexts[1].options).toEqual({ sampleRate: 46875 });
        });

        it("fades the warning out once the audio is running again", () => {
            const handler = makeHandler();

            for (const context of contexts) context.state = "suspended";
            handler.checkStatus();
            for (const context of contexts) context.state = "running";
            handler.checkStatus();

            expect(warning().style.opacity).toBe("0");
        });
    });

    describe("when a worklet module fails to load", () => {
        const rejectModule = (name) => async (url) => {
            if (url.includes(name)) throw new Error("Blocked by an extension");
        };

        beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

        // A toast left mid-show leaks timers past this file's jsdom window:
        // bootstrap fakes transitionend with an uncancellable short timer,
        // which in turn arms the five second autohide. Let the transition
        // finish while this window is still current, then dispose to cancel
        // the autohide; either timer firing later crashes the run from
        // whichever test file is running at the time.
        afterEach(async () => {
            vi.restoreAllMocks();
            await vi.waitFor(() => {
                for (const el of document.querySelectorAll(".toast"))
                    expect(el.classList.contains("showing")).toBe(false);
            });
            for (const el of document.querySelectorAll(".toast")) bootstrap.Toast.getInstance(el)?.dispose();
        });

        it("says there will be no sound in the banner, and leaves it up", async () => {
            stubAudio({ addModule: rejectModule("audio-renderer") });

            const handler = makeHandler();

            await vi.waitFor(() => expect(warningShown()).toBe(true));
            expect(warning().textContent).toContain("no sound");
            expect(warning().textContent).toContain("Blocked by an extension");
            handler.checkStatus();
            expect(warningShown()).toBe(true);
        });

        it("toasts about the Music 5000 and leaves the banner down", async () => {
            stubAudio({ addModule: rejectModule("music5000") });

            makeHandler({ hasMusic5000: true });

            await vi.waitFor(() => expect(document.querySelector(".toast .message")).not.toBeNull());
            expect(document.querySelector(".toast .message").textContent).toContain("Music 5000 will be silent");
            expect(warningShown()).toBe(false);
        });
    });

    it("shows no warning when there is no audio at all", () => {
        makeHandler();

        expect(warningShown()).toBe(false);
    });
});
