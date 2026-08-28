import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";

import { applyFirCoefficients, applyLumaCoefficients } from "../../tools/vite-plugin-fir-shader.js";
import { LumaTaps } from "../../tools/luma-fir-generator.js";

const ShaderPath = new URL("../../src/video-filters/shaders/pal-composite.frag.glsl", import.meta.url);

const Section = `    // BEGIN_FIR_COEFFICIENTS
    // Cutoff: 2.0
    const int FIRTAPS = 5;
    float FIR[FIRTAPS];
    // END_FIR_COEFFICIENTS`;

const LumaSection = `    // BEGIN_LUMA_COEFFICIENTS
    const int LUMA_TAPS = 31;
    float LUMA_FIR[LUMA_TAPS];
    // END_LUMA_COEFFICIENTS`;

const assignedIndices = (code, name) =>
    [...code.matchAll(new RegExp(`${name}\\[(\\d+)\\] = `, "g"))].map((m) => Number(m[1]));

describe("FIR shader substitution", () => {
    it("leaves a shader without markers alone", () => {
        expect(applyFirCoefficients("void main() {}")).toBeNull();
    });

    it("fills the marked section in with every coefficient, at the section's indent", () => {
        const { code, taps, cutoff } = applyFirCoefficients(`void main() {\n${Section}\n}\n`);
        expect([taps, cutoff]).toEqual([5, 2]);
        expect(assignedIndices(code, "FIR")).toEqual([0, 1, 2, 3, 4]);
        for (const line of code.split("\n").filter((l) => l.includes("FIR[")))
            expect(line.startsWith("    ")).toBe(true);
    });

    it("regenerates a section it has already filled to the same text", () => {
        const once = applyFirCoefficients(Section).code;
        expect(applyFirCoefficients(once).code).toBe(once);
    });

    it("indents the marker lines once", () => {
        const { code } = applyFirCoefficients(`void main() {\n${Section}\n}\n`);
        expect(code).toContain("\n    // BEGIN_FIR_COEFFICIENTS\n    // Cutoff: 2\n");
        expect(code).toContain("\n    // END_FIR_COEFFICIENTS\n");
    });

    it("rejects markers in the wrong order", () => {
        expect(() => applyFirCoefficients("// END_FIR_COEFFICIENTS\n// BEGIN_FIR_COEFFICIENTS")).toThrow();
    });

    it("rejects a lone marker", () => {
        expect(() => applyFirCoefficients("// BEGIN_FIR_COEFFICIENTS\n")).toThrow();
        expect(() => applyFirCoefficients("// END_FIR_COEFFICIENTS\n")).toThrow();
    });

    it("rejects a section that names no cutoff or tap count", () => {
        expect(() => applyFirCoefficients("// BEGIN_FIR_COEFFICIENTS\n// END_FIR_COEFFICIENTS")).toThrow();
    });

    it("leaves the shipped shader with no uninitialised taps", () => {
        const { code, taps } = applyFirCoefficients(readFileSync(ShaderPath, "utf8"));
        expect(code.match(/FIR\[\d+\] = /g)).toHaveLength(taps);
    });
});

describe("luma FIR shader substitution", () => {
    it("leaves a shader without markers alone", () => {
        expect(applyLumaCoefficients("void main() {}")).toBeNull();
    });

    it("fills the marked section in with every coefficient, at the section's indent", () => {
        const { code, taps } = applyLumaCoefficients(`void main() {\n${LumaSection}\n}\n`);
        expect(taps).toBe(LumaTaps);
        expect(assignedIndices(code, "LUMA_FIR")).toEqual([...Array(LumaTaps).keys()]);
        for (const line of code.split("\n").filter((l) => l.includes("LUMA_FIR[")))
            expect(line.startsWith("    ")).toBe(true);
    });

    it("declares as many taps as it assigns", () => {
        const { code } = applyLumaCoefficients(LumaSection);
        expect(code).toContain(`const int LUMA_TAPS = ${LumaTaps};`);
    });

    it("regenerates a section it has already filled to the same text", () => {
        const once = applyLumaCoefficients(LumaSection).code;
        expect(applyLumaCoefficients(once).code).toBe(once);
    });

    it("leaves the chroma section alone", () => {
        const both = `void main() {\n${Section}\n\n${LumaSection}\n}\n`;
        expect(applyLumaCoefficients(both).code).toContain(Section);
        expect(applyFirCoefficients(both).code).toContain(LumaSection);
    });

    it("rejects markers in the wrong order", () => {
        expect(() => applyLumaCoefficients("// END_LUMA_COEFFICIENTS\n// BEGIN_LUMA_COEFFICIENTS")).toThrow();
    });

    it("rejects a lone marker", () => {
        expect(() => applyLumaCoefficients("// BEGIN_LUMA_COEFFICIENTS\n")).toThrow();
        expect(() => applyLumaCoefficients("// END_LUMA_COEFFICIENTS\n")).toThrow();
    });

    it("leaves the shipped shader with exactly LUMA_TAPS taps, all initialised", () => {
        const { code } = applyLumaCoefficients(applyFirCoefficients(readFileSync(ShaderPath, "utf8")).code);
        const declared = Number(/const int LUMA_TAPS = (\d+);/.exec(code)[1]);
        expect(declared).toBe(LumaTaps);
        expect(assignedIndices(code, "LUMA_FIR")).toEqual([...Array(declared).keys()]);
    });
});
