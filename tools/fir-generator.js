/**
 * FIR filter coefficient generator for PAL composite video chroma filtering.
 *
 * Based on reverse-engineering Rich's original coefficients (generated via ChatGPT):
 * - Uses Kaiser window with β=5
 * - The cutoff is the -6 dB point of the windowed sinc
 * - Normalized coefficients (sum = 1.0)
 * - Sample rate: 16 MHz
 */

const SAMPLE_RATE_HZ = 16e6;
const BETA = 5.0;

function sinc(x) {
    // Sinc function: sin(pi*x) / (pi*x), with sinc(0) = 1
    if (Math.abs(x) < 1e-10) {
        return 1.0;
    }
    return Math.sin(Math.PI * x) / (Math.PI * x);
}

function kaiserWindow(n, M, beta) {
    // Kaiser window with parameter beta
    const arg = beta * Math.sqrt(1 - Math.pow((2 * n) / (M - 1) - 1, 2));
    return Math.cosh(arg) / Math.cosh(beta);
}

function generateFirLowpass(numTaps, cutoffCyclesPerSample, beta) {
    // Generate FIR lowpass filter using Kaiser windowed sinc
    const center = (numTaps - 1) / 2;
    const coefficients = [];

    for (let n = 0; n < numTaps; n++) {
        // Ideal lowpass filter (sinc function)
        const t = n - center;
        const h = 2 * cutoffCyclesPerSample * sinc(2 * cutoffCyclesPerSample * t);

        // Apply Kaiser window
        const w = kaiserWindow(n, numTaps, beta);
        coefficients.push(h * w);
    }

    // Normalize so sum equals 1.0
    const total = coefficients.reduce((sum, c) => sum + c, 0);
    return coefficients.map((c) => c / total);
}

/**
 * Generate FIR filter coefficients and format as GLSL array initialization.
 *
 * @param {number} numTaps - Number of filter taps (must be odd)
 * @param {number} cutoffMhz - Cutoff frequency in MHz
 * @param {string} indent - Indentation string to prepend to each line
 * @returns {string} GLSL array initialization code
 */
export function generateFirCoefficients(numTaps, cutoffMhz, indent) {
    // Validate inputs
    if (numTaps <= 0 || numTaps % 2 === 0) {
        throw new Error(`numTaps must be a positive odd number, got ${numTaps}`);
    }
    if (cutoffMhz <= 0 || cutoffMhz > 8) {
        throw new Error(`cutoffMhz must be between 0 and 8 MHz (Nyquist), got ${cutoffMhz}`);
    }

    const cutoffCyclesPerSample = (cutoffMhz * 1e6) / SAMPLE_RATE_HZ;

    const coeffs = generateFirLowpass(numTaps, cutoffCyclesPerSample, BETA);

    // Format as GLSL array initialization (4 per line)
    const lines = [];
    for (let i = 0; i < coeffs.length; i += 4) {
        const chunk = coeffs.slice(i, i + 4);
        const formatted = chunk.map((c, j) => `FIR[${i + j}] = ${c.toPrecision(10)}`).join("; ");
        lines.push(`${indent}${formatted};`);
    }

    return lines.join("\n");
}
