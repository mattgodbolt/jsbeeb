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
    const cutoffMatch = markedSection.match(/\/\/\s*Cutoff:\s*(\d+(?:\.\d+)?)/);
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
 * @param {string} indent - Indentation string to use (e.g., "    ")
 * @returns {string} - Complete marked section with generated code
 */
function generateFirSection(taps, cutoff, indent) {
    const coeffCode = generateFirCoefficients(taps, cutoff, indent);

    return `${indent}${FIR_BEGIN_MARKER}
${indent}// Cutoff: ${cutoff}
${indent}const int FIRTAPS = ${taps};
${indent}float FIR[FIRTAPS];
${coeffCode}
${indent}${FIR_END_MARKER}`;
}

/**
 * Replace the marked section of a shader with freshly generated coefficients.
 *
 * @param {string} code - GLSL source
 * @returns {{ code: string, taps: number, cutoff: number } | null} the transformed
 *     source and the parameters it was generated from, or null when the source has
 *     no marked section
 * @throws {Error} when the marked section is malformed
 */
export function applyFirCoefficients(code) {
    if (!code.includes(FIR_BEGIN_MARKER) || !code.includes(FIR_END_MARKER)) {
        return null;
    }

    const beginIdx = code.indexOf(FIR_BEGIN_MARKER);
    const endIdx = code.indexOf(FIR_END_MARKER);
    if (endIdx < beginIdx) {
        throw new Error("Invalid FIR marker order");
    }

    // Detect indentation by finding the start of the line containing BEGIN marker
    const lineStart = code.lastIndexOf("\n", beginIdx) + 1;
    const indent = code.substring(lineStart, beginIdx);

    const markedSection = code.substring(beginIdx, endIdx + FIR_END_MARKER.length);

    const params = parseFirParams(markedSection);
    if (!params) {
        throw new Error("Could not parse FIR parameters");
    }

    const newSection = generateFirSection(params.taps, params.cutoff, indent);
    return { code: code.replace(markedSection, newSection), ...params };
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

            let result;
            try {
                result = applyFirCoefficients(code);
            } catch (err) {
                console.warn(`[FIR Plugin] ${err.message} in ${filePath}`);
                return null;
            }
            if (!result) {
                return null;
            }

            console.log(
                `[FIR Plugin] Generated ${result.taps}-tap filter @ ${result.cutoff} MHz for ${filePath.split("/").pop()}`,
            );

            // Return as a JavaScript module exporting the string.
            // moduleType is required by Vite 8+ for non-.js file extensions.
            return {
                code: `export default ${JSON.stringify(result.code)}`,
                map: null,
                moduleType: "js",
            };
        },
    };
}
