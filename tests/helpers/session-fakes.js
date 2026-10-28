import { vi } from "vitest";

import { Cmos } from "../../src/cmos.js";
import { keyCodes } from "../../src/keymap.js";
import { Parameters, takenFromHostValues } from "../../src/web/parameters.js";

export const CyclesPerSecond = 2000000;

export const plainCodec = {
    compress: async (text) => new TextEncoder().encode(text),
    decompress: async (bytes) => new TextDecoder().decode(bytes),
};

const DefaultSettings = Object.fromEntries(
    Object.entries(Parameters)
        .filter(([, parameter]) => "default" in parameter)
        .map(([name, parameter]) => [name, parameter.default]),
);
export const StockTakenFromHost = takenFromHostValues(DefaultSettings, {});

// A layout in which "a" is at [4, 1], and "@" is the same key with BBC SHIFT forced up.
export const fakeKeyMapping = (key, shiftDown) => ({ a: [4, 1], "@": shiftDown ? [4, 1, false] : undefined })[key];

const KeyNames = { " ": "SPACE", "-": "MINUS", "\n": "ENTER" };

/** The key that types `char`, unshifted. */
export const keyCodeFor = (char) => keyCodes[KeyNames[char] ?? (/\d/.test(char) ? `K${char}` : char)];

/** As much of a processor as a session and its sequencer touch, running `cycles` in. */
export function fakeProcessor({ cycles = 1000 } = {}) {
    const processor = {
        cycleSeconds: 0,
        currentCycles: cycles,
        targetCycles: cycles,
        model: { cyclesPerSecond: CyclesPerSecond, swram: [] },
        hasTube: false,
        a: 0,
        x: 0,
        y: 0,
        s: 0,
        pc: 0,
        p: { asByte: () => 0 },
        ramRomOs: new Uint8Array(16),
        romOffset: 16,
        resetLine: true,
        setReset(resetOn) {
            this.resetLine = !resetOn;
        },
        fdc: { drives: [] },
        adconverter: { setFixedValue: vi.fn() },
        // As at a breakpoint: the CPU stops here, short of its target.
        stopAt: Infinity,
        execute(count) {
            this.targetCycles += count;
            if (this.targetCycles > this.stopAt) {
                this.currentCycles = this.stopAt;
                this.stopAt = Infinity;
                return false;
            }
            this.currentCycles = Math.max(this.currentCycles, this.targetCycles);
            return true;
        },
        snapshotState: () => ({ cycles: processor.currentCycles }),
        restoreState: vi.fn((state) => {
            processor.currentCycles = processor.targetCycles = state.cycles;
        }),
        sysvia: {
            keys: [],
            keyMapping: fakeKeyMapping,
            setMapped: vi.fn(),
            keyboardState: () => ({ keys: [] }),
            restoreKeyboard: vi.fn(),
            cmos: new Cmos(null),
        },
    };
    return processor;
}

// As much of the page as a session touches, keeping what it was told and shown, and going when told to.
export function fakePage() {
    const fake = {
        notices: [],
        panels: [],
        reloads: [],
        hideListeners: [],
        watching: null,
        notify: (text) => fake.notices.push(text),
        hidden: () => false,
        watch(log) {
            fake.watching = log;
            return () => (fake.watching = null);
        },
        onPageHide: (listener, signal) => fake.hideListeners.push({ listener, signal }),
        hide: () => fake.hideListeners.filter(({ signal }) => !signal.aborted).forEach(({ listener }) => listener()),
        joinLink: (room) => `https://example.com/?client=${room}`,
        reloadAs: (params) => fake.reloads.push(params),
        panel(session, setTakeOnKey) {
            const panel = {
                setTakeOnKey,
                opens: 0,
                open() {
                    ++panel.opens;
                },
                show(heading, summary, peers) {
                    Object.assign(panel, { heading, summary, peers });
                },
                showControl(who, canTake) {
                    Object.assign(panel, { who, canTake });
                },
                showTakeOnKey(on) {
                    panel.takeOnKey = on;
                },
            };
            fake.panels.push(panel);
            return panel;
        },
    };
    return fake;
}
