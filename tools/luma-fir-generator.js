/**
 * FIR filter coefficient generator for the PAL display's luma path: the set's
 * low-pass and subcarrier trap in one symmetric kernel at the 16 MHz texel rate.
 *
 * A Hann-windowed sinc low-pass convolved with a trap (identity minus a
 * Kaiser-windowed bandpass of unit gain at the subcarrier), normalised to unit
 * DC. Baked into the shader by vite-plugin-fir-shader.js.
 */

import { formatCoefficients } from "./fir-generator.js";

export const LumaTaps = 31;
const SampleRateMhz = 16;
const PalSubcarrierMhz = 4.43361875;
// The IF strip's roll-off below the sound carrier, as the picture came in by UHF.
const LumaBandwidthMhz = 4.5;
const LowpassTaps = 13;
// The two convolve to LumaTaps.
const NotchTaps = LumaTaps - LowpassTaps + 1;
// A lower beta narrows the trap, at the cost of ripple either side of it.
const NotchBeta = 3;

const sinc = (x) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
// Windows span taps+2 points so the outermost taps are not wasted on zeros.
const hann = (n, taps) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 1)) / (taps + 1));
const kaiser = (n, taps, beta) => {
    const r = (2 * (n + 1)) / (taps + 1) - 1;
    return besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta);
};

function besselI0(x) {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 50; k++) {
        term *= (x / (2 * k)) ** 2;
        sum += term;
    }
    return sum;
}

const centreOf = (taps) => (taps - 1) / 2;

function lowpassKernel(cutoffMhz, taps) {
    const cutoff = cutoffMhz / SampleRateMhz;
    const centre = centreOf(taps);
    const kernel = [];
    for (let n = 0; n < taps; n++) kernel.push(2 * cutoff * sinc(2 * cutoff * (n - centre)) * hann(n, taps));
    return kernel;
}

function notchKernel(taps, beta) {
    const omega = (2 * Math.PI * PalSubcarrierMhz) / SampleRateMhz;
    const centre = centreOf(taps);
    const bandpass = [];
    for (let n = 0; n < taps; n++) bandpass.push(Math.cos(omega * (n - centre)) * kaiser(n, taps, beta));
    const gainAtSubcarrier = bandpass.reduce((sum, x, n) => sum + x * Math.cos(omega * (n - centre)), 0);
    return bandpass.map((x, n) => (n === centre ? 1 : 0) - x / gainAtSubcarrier);
}

function convolve(a, b) {
    const result = new Array(a.length + b.length - 1).fill(0);
    a.forEach((x, i) => b.forEach((y, j) => (result[i + j] += x * y)));
    return result;
}

function unitDc(kernel) {
    const sum = kernel.reduce((total, x) => total + x, 0);
    return kernel.map((x) => x / sum);
}

/** @returns {number[]} LumaTaps coefficients summing to one */
export function generateLumaKernel() {
    return unitDc(convolve(lowpassKernel(LumaBandwidthMhz, LowpassTaps), notchKernel(NotchTaps, NotchBeta)));
}

/**
 * Generate the luma kernel and format it as GLSL array initialization.
 *
 * @param {string} indent - Indentation string to prepend to each line
 * @returns {string} GLSL array initialization code
 */
export function generateLumaCoefficients(indent) {
    return formatCoefficients("LUMA_FIR", generateLumaKernel(), indent);
}
