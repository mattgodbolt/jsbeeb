// Defaults for the stages between the sound chip and the device, shared by the
// worklet and by tools that replay the same path headlessly.

// The board's output filter is an equal-component Sallen-Key (Service Manual
// section 3.8: 10K and 2n2 twice, gain K = 1 + 22/39): f0 = 1/(2*pi*RC) = 7234 Hz,
// Q = 1/(3 - K) = 0.696, below 1/sqrt(2), so no resonant peak. Run at the chip
// rate, ahead of the resampler.
export const OutputFilterHz = 7234;
export const OutputFilterQ = 0.696;

// The resampler's sinc is cut off below the output Nyquist so that its
// transition band has finished before anything folds; sampled sound rides on
// a 31 kHz or higher carrier that would otherwise land in the audible band.
export const ResamplerCutoffOfOutputRate = 0.4;
export const ResamplerTaps = 201;
