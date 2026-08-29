// The stages between the sound chip and the device, shared by the worklet and
// by tools that replay the same path headlessly. Values and their sources are
// in docs/audio-path.md.

import { Biquad } from "./biquad.js";

// The board's output filter is an equal-component Sallen-Key (Service Manual
// section 3.8: 10K and 2n2 twice, gain K = 1 + 22/39): f0 = 1/(2*pi*RC) = 7234 Hz,
// Q = 1/(3 - K) = 0.696, below 1/sqrt(2), so no resonant peak. Run at the chip
// rate, ahead of the resampler.
export const OutputFilterHz = 7234;
export const OutputFilterQ = 0.696;

// The coupling capacitors after the filter, each a first-order high-pass:
// C10 100nF into the LM386's 50K input, C79 330nF into 4K7 + 1K (Master only),
// and C18 47uF into the 8 ohm speaker.
export const BoardHighPassHz = [32, 85, 423];

// The internal speaker and case, fitted to microphone captures of a Master 128
// (the driver's resonance, a presence bump, and the roll-off above 6 kHz).
export const SpeakerStages = [
    { type: "highPass", frequency: 550, q: 1.56 },
    { type: "peaking", frequency: 460, q: 3.5, gainDb: 16.5 },
    { type: "peaking", frequency: 2750, q: 0.5, gainDb: 13.9 },
    { type: "highShelf", frequency: 5600, q: 1.3, gainDb: -16.7 },
    { type: "lowPass", frequency: 11700, q: 1.7 },
];

// The resampler's sinc is cut off below the output Nyquist so that its
// transition band has finished before anything folds; sampled sound rides on
// a 31 kHz or higher carrier that would otherwise land in the audible band.
export const ResamplerCutoffOfOutputRate = 0.4;
export const ResamplerTaps = 201;

export const AudioOutputs = Object.freeze({
    speaker: "speaker",
    board: "board",
    off: "off",
});
export const DefaultAudioOutput = AudioOutputs.speaker;

export function isAudioOutput(value) {
    return Object.values(AudioOutputs).includes(value);
}

const stageFactories = {
    lowPass: (rate, s) => Biquad.lowPass(rate, s.frequency, s.q),
    highPass: (rate, s) => Biquad.highPass(rate, s.frequency, s.q),
    peaking: (rate, s) => Biquad.peaking(rate, s.frequency, s.q, s.gainDb),
    highShelf: (rate, s) => Biquad.highShelf(rate, s.frequency, s.q, s.gainDb),
};

const GainProbeHz = [...Array(400).keys()].map((i) => 20 * 2 ** (i / 40));

function chainMagnitude(stages, sampleRate, hz) {
    return stages.reduce((gain, stage) => gain * stage.magnitudeAt(sampleRate, hz), 1);
}

// The speaker's presence bump would push loud chords past full scale, so the
// chain is scaled to peak at unity across the band.
function speakerStages(sampleRate) {
    const stages = SpeakerStages.map((stage) => stageFactories[stage.type](sampleRate, stage));
    const peak = Math.max(...GainProbeHz.map((hz) => chainMagnitude(stages, sampleRate, hz)));
    return [...stages, Biquad.gain(1 / peak)];
}

// Zero turns the whole path off; a setting the biquad cannot realise
// (non-finite, at or above Nyquist, non-positive Q) falls back to the board's
// own values.
function boardFilter(sampleRate, frequency = OutputFilterHz, q = OutputFilterQ) {
    const usable = frequency < sampleRate / 2 && q > 0;
    if (!usable) return Biquad.lowPass(sampleRate, OutputFilterHz, OutputFilterQ);
    return Biquad.lowPass(sampleRate, frequency, q);
}

/**
 * The filters to run on the chip's output, in order, for the chosen output.
 *
 * @param {number} sampleRate the chip's rate
 * @param {string} output one of AudioOutputs
 * @param {{filterHz?: number, filterQ?: number}} board overrides for the board's low-pass
 * @returns {Biquad[]}
 */
export function outputStages(sampleRate, output, { filterHz, filterQ } = {}) {
    if (output === AudioOutputs.off || filterHz <= 0) return [];
    const board = [
        boardFilter(sampleRate, filterHz, filterQ),
        ...BoardHighPassHz.map((hz) => Biquad.firstOrderHighPass(sampleRate, hz)),
    ];
    if (output === AudioOutputs.board) return board;
    return [...board, ...speakerStages(sampleRate)];
}
