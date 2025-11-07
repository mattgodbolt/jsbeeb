/**
 * Vite plugin to auto-generate FIR filter coefficients in GLSL shaders at build time.
 *
 * Looks for marked sections in .glsl files:
 *   // BEGIN_FIR_COEFFICIENTS
 *   // Cutoff: 2.217
 *   const int FIRTAPS = 51;
 *   float FIR[FIRTAPS];
 *   ... generated code ...
 *   // END_FIR_COEFFICIENTS
 *
 * Parses the cutoff frequency and FIRTAPS constant, then regenerates the coefficient
 * initialization code using Kaiser windowed sinc filter design.
 */

import { readFileSync } from "fs";
import { generateFirCoefficients } from "./fir-generator.js";

const FIR_BEGIN_MARKER = "// BEGIN_FIR_COEFFICIENTS";
const FIR_END_MARKER = "// END_FIR_COEFFICIENTS";

/**
 * Parse FIR parameters from the marker comment block.
 *
 * @param {string} markedSection - The text between BEGIN and END markers
 * @returns {{ cutoff: number, taps: number } | null} - Parsed parameters or null if invalid
 */
function parseFirParams(markedSection) {
    const cutoffMatch = markedSection.match(/\/\/\s*Cutoff:\s*([\d.]+)/);
    const tapsMatch = markedSection.match(/const\s+int\s+FIRTAPS\s*=\s*(\d+)/);

    if (!cutoffMatch || !tapsMatch) {
        return null;
    }

    return {
        cutoff: parseFloat(cutoffMatch[1]),
        taps: parseInt(tapsMatch[1], 10),
    };
}

/**
 * Generate the complete FIR coefficient section including markers.
 *
 * @param {number} taps - Number of filter taps
 * @param {number} cutoff - Cutoff frequency in MHz
 * @returns {string} - Complete marked section with generated code
 */
function generateFirSection(taps, cutoff) {
    const coeffCode = generateFirCoefficients(taps, cutoff);

    return `${FIR_BEGIN_MARKER}
    // Cutoff: ${cutoff}
    const int FIRTAPS = ${taps};
    float FIR[FIRTAPS];
${coeffCode}
    ${FIR_END_MARKER}`;
}

/**
 * Vite plugin for FIR coefficient generation.
 */
export function firShaderPlugin() {
    return {
        name: "fir-shader-transform",
        enforce: "pre", // Run before Vite's internal transforms

        load(id) {
            // Only process .glsl files with ?raw suffix
            if (!id.includes(".glsl?raw")) {
                return null;
            }

            // Remove query parameters to get the actual file path
            const filePath = id.split("?")[0];

            // Read the file
            let code;
            try {
                code = readFileSync(filePath, "utf-8");
            } catch (err) {
                console.error(`[FIR Plugin] Failed to read ${filePath}:`, err);
                return null;
            }

            // Check if file contains FIR coefficient markers
            if (!code.includes(FIR_BEGIN_MARKER) || !code.includes(FIR_END_MARKER)) {
                return null;
            }

            // Extract the marked section
            const beginIdx = code.indexOf(FIR_BEGIN_MARKER);
            const endIdx = code.indexOf(FIR_END_MARKER);

            if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
                console.warn(`[FIR Plugin] Invalid FIR markers in ${filePath}`);
                return null;
            }

            const markedSection = code.substring(beginIdx, endIdx + FIR_END_MARKER.length);

            // Parse parameters from comments
            const params = parseFirParams(markedSection);
            if (!params) {
                console.warn(`[FIR Plugin] Could not parse FIR parameters in ${filePath}`);
                return null;
            }

            // Generate new section
            const newSection = generateFirSection(params.taps, params.cutoff);

            // Replace old section with new
            const transformedCode = code.replace(markedSection, newSection);

            console.log(
                `[FIR Plugin] Generated ${params.taps}-tap filter @ ${params.cutoff} MHz for ${filePath.split("/").pop()}`,
            );

            // Return as a JavaScript module exporting the string
            return {
                code: `export default ${JSON.stringify(transformedCode)}`,
                map: null,
            };
        },
    };
}
