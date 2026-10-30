import { SoundChip, ToneCounterSteps } from "../soundchip.js";
import { decodedPanel, DecodedRegisters, register, spelt } from "./decoded-registers.js";
import { MenuGroup } from "./floating-panel.js";
import { EndEdge, StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 240, h: 120 };
const NoiseChannel = 3;
const ChipClockHz = 4_000_000;
const ToneClockHz = ChipClockHz / 32;
const NoiseDividers = [512, 1024, 2048];
const NoiseRateMask = 3;
const NoiseFollowsTone2 = 3;
const Tone2 = 2;
const NoiseWhiteBit = 4;
const PeriodicNoiseShifts = 15;
const Silent = 15;
const DbPerAttenuationStep = 2;
const LowestAudibleHz = 20;
const HighestAudibleHz = 20_000;
const NoteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4Hz = 440;
const A4Midi = 69;
const SemitonesPerOctave = 12;
const CentsPerSemitone = 100;
const ChannelNames = ["tone 0", "tone 1", "tone 2", "noise"];

const HzForms = ["125000.0 Hz"];
const NoteForms = ["C#10 -50c", "inaudible"];
const VolumeForms = ["-28 dB", "off"];
const NoiseModes = ["periodic", "white"];
const NoiseRates = [...NoiseDividers.map((divider) => `/${divider}`), "tone 2"];
const RegisterNames = ChannelNames.flatMap((channel) => [
    `${channel} ${channel === "noise" ? "control" : "pitch"}`,
    `${channel} volume`,
]);
const LatchForms = RegisterNames.map((name, index) => `R${index}: ${name}`);

const toneHz = (period) => ToneClockHz / (period || ToneCounterSteps);

/** The equal-tempered note nearest `hz`, with how far off it is in cents, as "C#4 +12c". */
function noteName(hz) {
    if (hz < LowestAudibleHz || hz > HighestAudibleHz) return "inaudible";
    const semitones = A4Midi + SemitonesPerOctave * Math.log2(hz / A4Hz);
    const nearest = Math.round(semitones);
    const cents = Math.round((semitones - nearest) * CentsPerSemitone);
    const octave = Math.floor(nearest / SemitonesPerOctave) - 1;
    return `${NoteNames[nearest % SemitonesPerOctave]}${octave} ${cents < 0 ? "" : "+"}${cents}c`;
}

const hzText = (hz) => `${hz.toFixed(1)} Hz`;

function noiseShiftHz(control, periods) {
    const rate = control & NoiseRateMask;
    return rate === NoiseFollowsTone2 ? toneHz(periods[Tone2]) : ChipClockHz / NoiseDividers[rate];
}

function decodeVolume(attenuation) {
    const text = attenuation === Silent ? "off" : `-${attenuation * DbPerAttenuationStep} dB`;
    return [spelt(text, `Attenuation ${attenuation} of ${Silent}, each step ${DbPerAttenuationStep} dB`, VolumeForms)];
}

function decodeTone(period) {
    const hz = toneHz(period);
    return [
        spelt(hzText(hz), "4 MHz / 32N, where a period N of 0 counts as 1024", HzForms),
        spelt(noteName(hz), "The nearest note, A4 at 440 Hz, and how far off it is in cents", NoteForms),
    ];
}

function decodeNoise(control, { periods }) {
    const white = control & NoiseWhiteBit;
    const shiftHz = noiseShiftHz(control, periods);
    const meanings = [
        spelt(
            NoiseModes[white ? 1 : 0],
            "Bit 2: white noise, or a periodic tone at a fifteenth of the shift rate",
            NoiseModes,
        ),
        spelt(
            NoiseRates[control & NoiseRateMask],
            "Bits 0 and 1: the shift rate, the 4 MHz clock divided down or tone 2's frequency",
            NoiseRates,
        ),
    ];
    if (white) return [...meanings, spelt(hzText(shiftHz), "How often the noise shifts", HzForms)];
    const hz = shiftHz / PeriodicNoiseShifts;
    return [
        ...meanings,
        spelt(hzText(hz), "The periodic tone's frequency", HzForms),
        spelt(noteName(hz), "The nearest note, A4 at 440 Hz, and how far off it is in cents", NoteForms),
    ];
}

const decodeLatch = (latched) => [
    spelt(LatchForms[latched], "The register a write without its top bit set goes to", LatchForms),
];

function channelSection(channel) {
    const name = ChannelNames[channel];
    const pitch =
        channel === NoiseChannel
            ? register(`R${2 * channel}`, "The noise control", 8, ({ periods }) => periods[channel], decodeNoise)
            : register(`R${2 * channel}`, `The ${name} period`, 16, ({ periods }) => periods[channel], decodeTone);
    const volume = register(
        `R${2 * channel + 1}`,
        `The ${name} attenuation`,
        8,
        ({ attenuations }) => attenuations[channel],
        decodeVolume,
    );
    return { heading: name[0].toUpperCase() + name.slice(1), registers: [pitch, volume] };
}

const Sections = [
    ...ChannelNames.map((_, channel) => channelSection(channel)),
    {
        heading: "Latch",
        registers: [register("Latched", "The latched register", 8, ({ latched }) => latched, decodeLatch)],
    },
];

/** Plain reads of the chip's fields, which leave it as it was: no catching up, no rendering. */
function soundState(chip) {
    return {
        periods: chip.registers,
        attenuations: ChannelNames.map((_, channel) => chip.attenuation(channel)),
        latched: chip.latchedRegister >>> 4,
    };
}

/**
 * A floating panel showing the SN76489's registers decoded, with toggles that mute its channels in what is heard.
 * The mutes are lifted as it closes, so that nothing stays muted out of sight.
 */
export class SoundChipPanel {
    /** Whether the machine has an SN76489 emulated: the Atom has none, and without audio the chip is a stand-in. */
    static fits(cpu) {
        return !cpu.model.isAtom && cpu.soundChip instanceof SoundChip;
    }

    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {{setChannelMutes: function(boolean[]): void}} options.audio
     */
    constructor({ cpu, arrangement, audio }) {
        this._chip = cpu.soundChip;
        this._audio = audio;
        this._muted = ChannelNames.map(() => false);
        const { floating, body } = decodedPanel({
            id: "soundchip",
            title: "Sound chip",
            menuGroup: MenuGroup.hardware,
            feature: "sound_chip",
            place: () => ({ x: EndEdge, y: StartEdge }),
            minSize: MinPanelSize,
            arrangement,
            draw: () => this.update(),
        });
        this.floating = floating;
        const column = document.createElement("div");
        column.className = "soundchip-registers";
        this._registers = new DecodedRegisters(column, Sections);
        column.append(this._muteStrip());
        body.append(column);
        floating.addEventListener("close", () => {
            if (this._muted.some(Boolean)) this._setMuted(this._muted.map(() => false));
        });
        this.update();
    }

    _muteStrip() {
        const strip = document.createElement("div");
        strip.className = "soundchip-mutes";
        strip.textContent = "Mute";
        this._muteButtons = ChannelNames.map((name, channel) => {
            const button = document.createElement("button");
            button.type = "button";
            button.tabIndex = -1;
            button.className = "decoded-bit";
            button.setAttribute("aria-pressed", "false");
            button.textContent = name;
            button.title = `Mute ${name} in what is heard; the emulated chip is unchanged`;
            button.addEventListener("click", () =>
                this._setMuted(this._muted.map((muted, other) => (other === channel ? !muted : muted))),
            );
            return button;
        });
        strip.append(...this._muteButtons);
        return strip;
    }

    _setMuted(muted) {
        this._muted = muted;
        this._audio.setChannelMutes(muted);
        this._muteButtons.forEach((button, channel) => {
            button.classList.toggle("lit", muted[channel]);
            button.setAttribute("aria-pressed", String(muted[channel]));
        });
    }

    update() {
        this._registers.update(soundState(this._chip));
    }
}
