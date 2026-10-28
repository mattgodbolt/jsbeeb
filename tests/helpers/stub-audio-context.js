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
