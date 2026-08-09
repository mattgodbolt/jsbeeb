// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioHandler } from "../../src/web/audio-handler.js";

const SuspendedText = "Your browser has suspended audio";

describe("AudioHandler", () => {
    let contexts;

    function fakeNode() {
        return { connect: () => {}, gain: { value: 0 }, frequency: { value: 0 }, Q: { value: 0 }, type: "" };
    }

    function fakeContext(hasWorklet, addModule) {
        return {
            state: "running",
            destination: {},
            audioWorklet: hasWorklet ? { addModule } : undefined,
            createGain: fakeNode,
            createBiquadFilter: fakeNode,
            resume: async () => {},
        };
    }

    function stubAudio({ hasWorklet = true, addModule = async () => {} } = {}) {
        vi.stubGlobal(
            "AudioContext",
            class {
                constructor() {
                    const context = fakeContext(hasWorklet, addModule);
                    contexts.push(context);
                    return context;
                }
            },
        );
        vi.stubGlobal(
            "AudioWorkletNode",
            class {
                constructor() {
                    this.port = { postMessage: () => {}, onmessage: null };
                }
                connect() {}
            },
        );
    }

    function makeHandler() {
        return new AudioHandler({
            warningNode: document.getElementById("audio-warning"),
            audioFilterFreq: 0,
            audioFilterQ: 0,
            noSeek: true,
            cpuSpeed: 2000000,
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
        afterEach(() => vi.restoreAllMocks());

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

            makeHandler();

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
