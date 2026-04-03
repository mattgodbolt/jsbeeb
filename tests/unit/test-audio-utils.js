import { describe, it, expect, vi, afterEach } from "vitest";
import { createAudioContext } from "../../src/audio-utils.js";

describe("createAudioContext", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("should return null when no AudioContext is available", () => {
        vi.stubGlobal("AudioContext", undefined);
        vi.stubGlobal("webkitAudioContext", undefined);
        expect(createAudioContext()).toBeNull();
    });

    it("should use AudioContext when available", () => {
        const mockCtx = { state: "suspended" };
        vi.stubGlobal(
            "AudioContext",
            class {
                constructor() {
                    return mockCtx;
                }
            },
        );
        expect(createAudioContext()).toBe(mockCtx);
    });

    it("should pass options to AudioContext", () => {
        let receivedOptions;
        vi.stubGlobal(
            "AudioContext",
            class {
                constructor(options) {
                    receivedOptions = options;
                }
            },
        );
        createAudioContext({ sampleRate: 46875 });
        expect(receivedOptions).toEqual({ sampleRate: 46875 });
    });

    it("should fall back to webkitAudioContext", () => {
        vi.stubGlobal("AudioContext", undefined);
        const mockCtx = { state: "suspended" };
        vi.stubGlobal(
            "webkitAudioContext",
            class {
                constructor() {
                    return mockCtx;
                }
            },
        );
        expect(createAudioContext()).toBe(mockCtx);
    });
});
