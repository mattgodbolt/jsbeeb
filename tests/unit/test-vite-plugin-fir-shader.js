import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";

import { applyFirCoefficients } from "../../tools/vite-plugin-fir-shader.js";

const ShaderPath = new URL("../../src/video-filters/shaders/pal-composite.frag.glsl", import.meta.url);

const Section = `    // BEGIN_FIR_COEFFICIENTS
    // Cutoff: 2.0
    const int FIRTAPS = 5;
    float FIR[FIRTAPS];
    // END_FIR_COEFFICIENTS`;

describe("FIR shader substitution", () => {
    it("leaves a shader without markers alone", () => {
        expect(applyFirCoefficients("void main() {}")).toBeNull();
    });

    it("fills the marked section in with every coefficient, at the section's indent", () => {
        const { code, taps, cutoff } = applyFirCoefficients(`void main() {\n${Section}\n}\n`);
        expect([taps, cutoff]).toEqual([5, 2]);
        expect([...code.matchAll(/FIR\[(\d+)\] = /g)].map((m) => Number(m[1]))).toEqual([0, 1, 2, 3, 4]);
        for (const line of code.split("\n").filter((l) => l.includes("FIR[")))
            expect(line.startsWith("    ")).toBe(true);
    });

    it("regenerates a section it has already filled to the same coefficients", () => {
        const once = applyFirCoefficients(Section).code;
        const twice = applyFirCoefficients(once).code;
        expect(twice.match(/FIR\[\d+\] = [^;]*/g)).toEqual(once.match(/FIR\[\d+\] = [^;]*/g));
    });

    it("rejects markers in the wrong order", () => {
        expect(() => applyFirCoefficients("// END_FIR_COEFFICIENTS\n// BEGIN_FIR_COEFFICIENTS")).toThrow();
    });

    it("rejects a section that names no cutoff or tap count", () => {
        expect(() => applyFirCoefficients("// BEGIN_FIR_COEFFICIENTS\n// END_FIR_COEFFICIENTS")).toThrow();
    });

    it("leaves the shipped shader with no uninitialised taps", () => {
        const { code, taps } = applyFirCoefficients(readFileSync(ShaderPath, "utf8"));
        expect(code.match(/FIR\[\d+\] = /g)).toHaveLength(taps);
    });
});
