// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { AudioHandler } from "../../src/web/audio-handler.js";
import { domFromIndexHtml, teardownDom, toasts } from "./helpers.js";

const SuspendedText = "Your browser has suspended audio";

describe("AudioHandler", () => {
    let contexts;
    let worklets;

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
                    this.name = name;
                    this.options = options;
                    worklets.push(this);
                    this.port = {
                        posted: [],
                        postMessage(message) {
                            this.posted.push(message);
                        },
                        onmessage: null,
                    };
                }
                connect() {}
            },
        );
    }

    /** The worklet node built under `name`, once the handler has built it. */
    async function worklet(name) {
        await vi.waitFor(() => expect(worklets.map((node) => node.name)).toContain(name));
        return worklets.find((node) => node.name === name);
    }
    /** What the handler posts to the sound chip's worklet from here on. */
    async function chipPosts() {
        const { port } = await worklet("sound-chip-processor");
        port.posted.length = 0;
        return port.posted;
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
        worklets = [];
        domFromIndexHtml("audio-warning");
        vi.stubGlobal("AudioContext", undefined);
        vi.stubGlobal("webkitAudioContext", undefined);
    });

    afterEach(teardownDom);

    describe("without an audio worklet API", () => {
        beforeEach(() => stubAudio({ hasWorklet: false }));

        it("says so in the warning banner, and is ready at once, as unavailable", async () => {
            const handler = makeHandler();

            expect(warningShown()).toBe(true);
            expect(warning().textContent).toContain("No audio worklet API");
            await expect(handler.ready).resolves.toBe("unavailable");
        });

        it("leaves the banner up when the audio status is checked", () => {
            const handler = makeHandler();

            handler.checkStatus();

            expect(warningShown()).toBe(true);
        });

        it("closes without taking the keyboard, and stays closed on the next visit", () => {
            makeHandler();
            const close = warning().querySelector(".btn-close");

            const mousedown = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
            close.dispatchEvent(mousedown);
            close.click();

            expect(mousedown.defaultPrevented).toBe(true);
            expect(warningShown()).toBe(false);
            document.body.innerHTML = "";
            domFromIndexHtml("audio-warning");
            makeHandler();
            expect(warningShown()).toBe(false);
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
            expect(warning().querySelector(".btn-close")).toBe(null);
        });

        it("ships the chip's writes with the emulator's position on flush", async () => {
            const handler = makeHandler();
            const posted = await chipPosts();

            handler.soundChip.scheduler.epoch = 5000;
            handler.soundChip.poke(0x8d);
            handler.flushChipEvents();
            handler.flushChipEvents();

            expect(posted).toEqual([
                { command: "produced", upTo: 5000, events: [{ cycle: 5000, kind: "poke", value: 0x8d }] },
                { command: "produced", upTo: 5000, events: [] },
            ]);
        });

        it("ships events as the emulation progresses, not only at the end of a tick", async () => {
            const handler = makeHandler();
            const scheduler = new Scheduler();
            handler.soundChip.setScheduler(scheduler);
            const posted = await chipPosts();

            handler.soundChip.poke(0x8d);
            scheduler.polltime(4000);

            expect(posted).toEqual([
                { command: "produced", upTo: 4000, events: [{ cycle: 0, kind: "poke", value: 0x8d }] },
            ]);
        });

        it("mutes ahead of the chip's timeline, unmutes behind what changed while stopped, and flushes both", async () => {
            const handler = makeHandler();
            const posted = await chipPosts();

            handler.mute();
            handler.unmute();

            expect(posted).toEqual([
                { command: "setEnabled", enabled: false },
                { command: "produced", upTo: 0, events: [] },
                { command: "produced", upTo: 0, events: [] },
                { command: "setEnabled", enabled: true },
            ]);
        });

        it("tells a worklet built after a mute that it starts muted", async () => {
            const handler = makeHandler();
            handler.mute();

            expect((await worklet("sound-chip-processor")).port.posted).toContainEqual({
                command: "setEnabled",
                enabled: false,
            });
        });

        it("hands the output filter settings to the worklet", async () => {
            makeHandler({ audioOutput: "board", audioFilterFreq: 1234, audioFilterQ: 0.5 });

            expect((await worklet("sound-chip-processor")).options.processorOptions).toMatchObject({
                audioOutput: "board",
                audioFilterFreq: 1234,
                audioFilterQ: 0.5,
            });
        });

        it("tells the worklet when the output changes", async () => {
            const handler = makeHandler();
            const posted = await chipPosts();

            handler.setAudioOutput("off");

            expect(posted).toEqual([{ command: "setAudioOutput", audioOutput: "off" }]);
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

        it("gives the Music 5000 worklet the latency target, and its changes, along with the main one", async () => {
            vi.spyOn(document, "hasFocus").mockReturnValue(true);
            const handler = makeHandler({ hasMusic5000: true, audioLatencyMs: 40 });
            const music5000 = await worklet("music5000");

            handler.setWindowFocused(false);

            expect(music5000.options.processorOptions).toEqual({ targetLatencyMs: 40 });
            expect(music5000.port.posted).toEqual([{ command: "setTargetLatency", targetLatencyMs: 200 }]);
        });

        it("ships Music 5000 blocks to its worklet as samples", async () => {
            const handler = makeHandler({ hasMusic5000: true });
            const music5000 = await worklet("music5000");
            const block = new Float64Array(256);

            handler._onBufferMusic5000(block);

            expect(music5000.port.posted).toEqual([{ command: "samples", samples: block }]);
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

        it("says there will be no sound in the banner, leaves it up, and is ready as unavailable", async () => {
            stubAudio({ addModule: rejectModule("audio-renderer") });

            const handler = makeHandler();

            await vi.waitFor(() => expect(warningShown()).toBe(true));
            expect(warning().textContent).toContain("no sound");
            expect(warning().textContent).toContain("Blocked by an extension");
            handler.checkStatus();
            expect(warningShown()).toBe(true);
            await expect(handler.ready).resolves.toBe("unavailable");
        });

        it("toasts about the Music 5000 and leaves the banner down", async () => {
            stubAudio({ addModule: rejectModule("music5000") });

            makeHandler({ hasMusic5000: true });

            await vi.waitFor(() => expect(toasts()).toEqual([expect.stringContaining("Music 5000 will be silent")]));
            expect(warningShown()).toBe(false);
        });
    });

    it("shows no warning when there is no audio at all, and is ready as unavailable", async () => {
        const handler = makeHandler();

        expect(warningShown()).toBe(false);
        await expect(handler.ready).resolves.toBe("unavailable");
    });

    it("is ready, as ok, once its output is set up", async () => {
        stubAudio();
        await expect(makeHandler().ready).resolves.toBe("ok");
    });

    it("initialises without waiting for its output to be set up", async () => {
        stubAudio({ addModule: () => new Promise(() => {}) });
        const handler = makeHandler();
        vi.spyOn(handler.relayNoise, "initialise").mockResolvedValue();
        const ready = vi.fn();
        handler.ready.then(ready);
        await handler.initialise();
        expect(ready).not.toHaveBeenCalled();
    });
});
