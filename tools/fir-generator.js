/**
 * FIR filter coefficient generator for PAL composite video chroma filtering.
 *
 * Based on reverse-engineering Rich's original coefficients (generated via ChatGPT):
 * - Uses Kaiser window with β=5
 * - Actual cutoff frequency is 0.5× the specified nominal frequency
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

function generateFirLowpass(numTaps, cutoffNormalized, beta) {
    // Generate FIR lowpass filter using Kaiser windowed sinc
    const center = (numTaps - 1) / 2;
    const coefficients = [];

    for (let n = 0; n < numTaps; n++) {
        // Ideal lowpass filter (sinc function)
        const t = n - center;
        const h = 2 * cutoffNormalized * sinc(2 * cutoffNormalized * t);

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
 * @param {number} nominalCutoffMhz - Nominal cutoff frequency in MHz
 * @returns {string} GLSL array initialization code
 */
export function generateFirCoefficients(numTaps, nominalCutoffMhz) {
    // Key discovery: actual cutoff is 0.5× the specified frequency
    const actualCutoffHz = nominalCutoffMhz * 1e6 * 0.5;
    const cutoffNormalized = actualCutoffHz / (SAMPLE_RATE_HZ / 2.0);

    const coeffs = generateFirLowpass(numTaps, cutoffNormalized, BETA);

    // Format as GLSL array initialization (4 per line)
    const lines = [];
    for (let i = 0; i < coeffs.length; i += 4) {
        const chunk = coeffs.slice(i, i + 4);
        const formatted = chunk.map((c, j) => `FIR[${i + j}] = ${c.toPrecision(10)}`).join("; ");
        lines.push(`    ${formatted};`);
    }

    return lines.join("\n");
}
