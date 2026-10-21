import { readdirSync } from "node:fs";

/** Chrome's switches for each renderer the e2e suite and the browser A/B can choose. */
export const GlArgs = {
    software: ["--use-gl=angle", "--use-angle=swiftshader"],
    hardware: ["--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist"],
};

/** Every switch the app needs from Chrome, drawing with the `gl` renderer. */
export const chromeArgs = (gl) => [...GlArgs[gl], "--autoplay-policy=no-user-gesture-required"];

export function hasGpu() {
    try {
        return readdirSync("/dev/dri").some((node) => /^(card|renderD)\d+$/.test(node));
    } catch {
        return false;
    }
}

export function checkGl(gl, setting) {
    if (!Object.hasOwn(GlArgs, gl))
        throw new Error(`${setting} must be one of ${Object.keys(GlArgs).join(", ")}, not "${gl}"`);
    return gl;
}
