import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";

const Shader = readFileSync(
    new URL("../../src/video-filters/shaders/pal-composite.frag.glsl", import.meta.url),
    "utf8",
);

/** Signal level of white: BT.470's 0.7 V, which the shader bakes into its matrices. */
const WhiteLevel = 0.7;

/** Six significant figures in the source; sums and products of those agree to about this. */
const Places = 4;

const ComponentColumn = { r: 0, g: 1, b: 2, x: 0, y: 1, z: 2 };

/**
 * The 3x3 matrix a shader function `name` applies to its `argument`, read out
 * of the constants in its `vec3(...)`: one row per line, one column per
 * component the constant multiplies.
 */
function matrixOf(name, argument) {
    const body = new RegExp(`vec3 ${name}\\(vec3 ${argument}\\) \\{([^}]*)\\}`).exec(Shader);
    if (!body) throw new Error(`No ${name} in the shader`);
    const term = new RegExp(`([-+]?)\\s*(\\d+\\.\\d+(?:e[-+]?\\d+)?)\\s*\\*\\s*${argument}\\.([rgbxyz])`, "g");
    const rows = [];
    for (const line of body[1].split("\n")) {
        const terms = [...line.matchAll(term)];
        if (terms.length === 0) continue;
        const row = [0, 0, 0];
        for (const [, sign, value, component] of terms)
            row[ComponentColumn[component]] = Number(value) * (sign === "-" ? -1 : 1);
        rows.push(row);
    }
    if (rows.length !== 3) throw new Error(`${name} has ${rows.length} rows, not 3`);
    return rows;
}

const multiply = (a, b) => a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));

const apply = (matrix, vector) => matrix.map((row) => row.reduce((sum, value, k) => sum + value * vector[k], 0));

const expectClose = (actual, expected) =>
    actual.forEach((row, i) => row.forEach((value, j) => expect(value).toBeCloseTo(expected[i][j], Places)));

describe("PAL composite shader matrices", () => {
    const rgbToYuv = matrixOf("rgb_to_yuv", "rgb");
    const yuvToRgb = matrixOf("yuv_to_rgb", "yuv");
    const identity = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ];

    it("undo each other in both orders", () => {
        expectClose(multiply(yuvToRgb, rgbToYuv), identity);
        expectClose(multiply(rgbToYuv, yuvToRgb), identity);
    });

    it("put white at the signal level with no chroma", () => {
        const [y, u, v] = apply(rgbToYuv, [1, 1, 1]);
        expect(y).toBeCloseTo(WhiteLevel, Places);
        expect(u).toBeCloseTo(0, Places);
        expect(v).toBeCloseTo(0, Places);
    });

    it("scale BT.470's luma weights by the signal level", () => {
        const bt470Luma = [0.299, 0.587, 0.114];
        rgbToYuv[0].forEach((value, i) => expect(value).toBeCloseTo(WhiteLevel * bt470Luma[i], Places));
    });
});
