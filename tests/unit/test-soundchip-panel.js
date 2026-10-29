// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { AtomSoundChip, FakeSoundChip, SoundChip } from "../../src/soundchip.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { SoundChipPanel } from "../../src/web/soundchip-panel.js";
import { decodedMeanings, decodedRow, teardownDom } from "./helpers.js";

const A440Period = 284;
const TwoOctavesBelowA440ByPeriodicNoise = 76;
const Tone0Volume = 0x90;
const Tone2Volume = 0xd0;
const NoiseControl = 0xe0;
const NoiseWhite = 4;
const NoiseFollowsTone2 = 3;
const Silent = 0x0f;

const toneWrites = (channel, period) => [0x80 | (channel << 5) | (period & 0x0f), period >> 4];

describe("SoundChipPanel", () => {
    let scheduler;
    let chip;
    let panel;
    let mutes;

    beforeEach(() => {
        scheduler = new Scheduler();
        chip = new SoundChip(() => {});
        chip.setScheduler(scheduler);
        mutes = [];
        panel = new SoundChipPanel({
            cpu: { soundChip: chip, model: { isAtom: false } },
            arrangement: new PanelArrangement(() => window.localStorage),
            audio: { setChannelMutes: (muted) => mutes.push(muted) },
        });
    });

    afterEach(teardownDom);

    const poke = (...values) => {
        for (const value of values) chip.poke(value);
        panel.update();
    };
    const meanings = (name) => decodedMeanings("soundchip-panel", name);
    const hex = (name) => decodedRow("soundchip-panel", name).querySelector(".decoded-hex").textContent;
    const muteButton = (name) =>
        [...document.querySelectorAll(".soundchip-mutes button")].find((button) => button.textContent === name);

    it("is offered on a machine with an emulated SN76489, and not the Atom's or a stand-in", () => {
        const fits = (soundChip, isAtom) => SoundChipPanel.fits({ soundChip, model: { isAtom } });
        expect(fits(chip, false)).toBe(true);
        expect(fits(new AtomSoundChip(() => {}), true)).toBe(false);
        expect(fits(new FakeSoundChip(), false)).toBe(false);
    });

    it("shows each tone's period as a frequency and the nearest note, and its volume", () => {
        poke(...toneWrites(0, A440Period), Tone0Volume | 2, ...toneWrites(1, 0), Tone0Volume | (1 << 5) | Silent);
        expect(hex("R0")).toBe("011c");
        expect(meanings("R0")).toEqual(["440.1 Hz", "A4 +1c"]);
        expect(meanings("R1")).toEqual(["-4 dB"]);
        expect(meanings("R2")).toEqual(["122.1 Hz", "B2 -20c"]);
        expect(meanings("R3")).toEqual(["off"]);
        poke(...toneWrites(2, 1));
        expect(meanings("R4")).toEqual(["125000.0 Hz", "inaudible"]);
    });

    it("shows the noise's mode and rate, and periodic noise's pitch, following tone 2 when told to", () => {
        poke(NoiseControl | NoiseWhite);
        expect(meanings("R6")).toEqual(["white", "/512", "7812.5 Hz"]);
        poke(...toneWrites(2, TwoOctavesBelowA440ByPeriodicNoise), NoiseControl | NoiseFollowsTone2);
        expect(meanings("R6")).toEqual(["periodic", "tone 2", "109.6 Hz", "A2 -6c"]);
        poke(...toneWrites(2, 0));
        expect(meanings("R6")).toEqual(["periodic", "tone 2", "8.1 Hz", "inaudible"]);
    });

    it("names the latched register, which a write without its top bit set goes to", () => {
        poke(Tone2Volume | 3);
        expect(meanings("Latched")).toEqual(["R5: tone 2 volume"]);
        poke(Silent);
        expect(meanings("R5")).toEqual(["off"]);
    });

    it("reads the chip without catching it up or changing it", () => {
        poke(...toneWrites(0, A440Period), Tone0Volume);
        const before = chip.snapshotState();
        const caughtUpTo = chip.lastRunEpoch;
        scheduler.polltime(10000);
        panel.update();
        expect(chip.lastRunEpoch).toBe(caughtUpTo);
        expect(chip.snapshotState()).toEqual(before);
    });

    it("mutes a channel in what is heard from its toggle, and lifts every mute as it closes", () => {
        panel.floating.open();
        expect(muteButton("tone 1").tabIndex).toBe(-1);
        muteButton("tone 1").click();
        muteButton("noise").click();
        expect(mutes.at(-1)).toEqual([false, true, false, true]);
        expect(muteButton("tone 1").classList.contains("lit")).toBe(true);
        muteButton("tone 1").click();
        expect(mutes.at(-1)).toEqual([false, false, false, true]);
        panel.floating.close();
        expect(mutes.at(-1)).toEqual([false, false, false, false]);
        expect(muteButton("noise").classList.contains("lit")).toBe(false);
    });
});
