// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioHandler } from "../../src/web/audio-handler.js";

const SuspendedText = "Your browser has suspended audio";

describe("AudioHandler", () => {
    let contexts;

    function fakeNode() {
        return { connect: () => {}, gain: { value: 0 }, frequency: { value: 0 }, Q: { value: 0 }, type: "" };
    }

    function fakeContext(hasWorklet) {
        return {
            state: "running",
            destination: {},
            audioWorklet: hasWorklet ? { addModule: async () => {} } : undefined,
            createGain: fakeNode,
            createBiquadFilter: fakeNode,
            resume: async () => {},
        };
    }

    function stubAudio({ hasWorklet = true } = {}) {
        vi.stubGlobal(
            "AudioContext",
            class {
                constructor() {
                    const context = fakeContext(hasWorklet);
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

    it("shows no warning when there is no audio at all", () => {
        makeHandler();

        expect(warningShown()).toBe(false);
    });
});
