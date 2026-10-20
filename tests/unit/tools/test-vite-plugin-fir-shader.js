import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";

import { applyFirCoefficients, applyLumaCoefficients } from "../../../tools/vite-plugin-fir-shader.js";
import { LumaTaps } from "../../../tools/luma-fir-generator.js";

const ShaderPath = new URL("../../../src/video-filters/shaders/pal-composite.frag.glsl", import.meta.url);

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

describe.each([
    {
        filter: "chroma",
        apply: applyFirCoefficients,
        section: Section,
        marker: "FIR_COEFFICIENTS",
        array: "FIR",
        taps: 5,
    },
    {
        filter: "luma",
        apply: applyLumaCoefficients,
        section: LumaSection,
        marker: "LUMA_COEFFICIENTS",
        array: "LUMA_FIR",
        taps: LumaTaps,
    },
])("$filter FIR shader substitution", ({ apply, section, marker, array, taps }) => {
    it("leaves a shader without markers alone", () => {
        expect(apply("void main() {}")).toBeNull();
    });

    it("fills the marked section in with every coefficient, at the section's indent", () => {
        const { code, taps: filled } = apply(`void main() {\n${section}\n}\n`);
        expect(filled).toBe(taps);
        expect(assignedIndices(code, array)).toEqual([...Array(taps).keys()]);
        for (const line of code.split("\n").filter((l) => l.includes(`${array}[`)))
            expect(line.startsWith("    ")).toBe(true);
    });

    it("regenerates a section it has already filled to the same text", () => {
        const once = apply(section).code;
        expect(apply(once).code).toBe(once);
    });

    it("rejects markers in the wrong order", () => {
        expect(() => apply(`// END_${marker}\n// BEGIN_${marker}`)).toThrow("marker order");
    });

    it("rejects a lone marker", () => {
        expect(() => apply(`// BEGIN_${marker}\n`)).toThrow("Unpaired");
        expect(() => apply(`// END_${marker}\n`)).toThrow("Unpaired");
    });

    it("leaves the shipped shader with every tap initialised", () => {
        const { code, taps: filled } = apply(readFileSync(ShaderPath, "utf8"));
        expect(assignedIndices(code, array)).toEqual([...Array(filled).keys()]);
    });
});

describe("chroma FIR section", () => {
    it("reads the cutoff from the section", () => {
        expect(applyFirCoefficients(Section).cutoff).toBe(2);
    });

    it("indents the marker lines once", () => {
        const { code } = applyFirCoefficients(`void main() {\n${Section}\n}\n`);
        expect(code).toContain("\n    // BEGIN_FIR_COEFFICIENTS\n    // Cutoff: 2\n");
        expect(code).toContain("\n    // END_FIR_COEFFICIENTS\n");
    });

    it("rejects a section that names no cutoff or tap count", () => {
        expect(() => applyFirCoefficients("// BEGIN_FIR_COEFFICIENTS\n// END_FIR_COEFFICIENTS")).toThrow(
            "Could not parse FIR parameters",
        );
    });
});

describe("luma FIR section", () => {
    it("declares as many taps as it assigns", () => {
        expect(applyLumaCoefficients(LumaSection).code).toContain(`const int LUMA_TAPS = ${LumaTaps};`);
    });

    it("leaves the chroma section alone, and the chroma substitution leaves it alone", () => {
        const both = `void main() {\n${Section}\n\n${LumaSection}\n}\n`;
        expect(applyLumaCoefficients(both).code).toContain(Section);
        expect(applyFirCoefficients(both).code).toContain(LumaSection);
    });
});
