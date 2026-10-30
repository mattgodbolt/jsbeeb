import { vi } from "vitest";

/** A running AudioContext with just the nodes SamplePlayer makes, every node method a spy. */
export function stubAudioContext() {
    return {
        state: "running",
        currentTime: 0,
        createGain: () => ({
            gain: {
                value: 1,
                setValueAtTime: vi.fn(),
                linearRampToValueAtTime: vi.fn(),
                cancelScheduledValues: vi.fn(),
            },
            connect: vi.fn(),
            disconnect: vi.fn(),
        }),
        createBufferSource: () => ({
            buffer: null,
            loop: false,
            onended: null,
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
        }),
    };
}

/**
 * The processor class a worklet module registers, caught by stubbing the AudioWorkletGlobalScope it reads at import
 * time. `importModule` does the import so its path resolves from the caller; the globals stay stubbed until
 * `vi.unstubAllGlobals()`.
 */
export async function loadWorkletProcessor(importModule, sampleRate) {
    let processor;
    vi.stubGlobal("sampleRate", sampleRate);
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal(
        "AudioWorkletProcessor",
        class {
            constructor() {
                this.port = { postMessage() {}, onmessage: null };
            }
        },
    );
    vi.stubGlobal("registerProcessor", (_name, registered) => {
        processor = registered;
    });
    await importModule();
    return processor;
}
