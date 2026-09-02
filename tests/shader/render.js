"use strict";

// Renders patterns through the project's real GLSL in headless Chrome and hands
// the pixels back, so a shader itself can be asserted on.
//
// Node has no WebGL, so the only way to execute a shader is to give it to a
// browser. Every pattern in a run is drawn by a single Chrome invocation:
// launching one costs far more than drawing into it.

import { existsSync, readFileSync } from "fs";
import path from "path";

import { chromium } from "@playwright/test";

/** Framebuffer stride, and the size of the square GL texture it is uploaded into. */
export const TextureSize = 1024;

const ShaderDir = new URL("../../src/video-filters/shaders/", import.meta.url);

/**
 * How to draw through one of the project's filters. The `setup` and `bind`
 * functions run inside the browser page, so they are serialised with
 * `Function.prototype.toString` and must be self-contained: nothing from Node
 * scope, only their arguments and `constants`.
 *
 * @typedef {object} FilterHarness
 * @property {string} vert vertex shader file name within src/video-filters/shaders
 * @property {string} frag fragment shader file name within src/video-filters/shaders
 * @property {(source: string) => string} [prepareFragment] the build step the
 *     app applies to the fragment source, if it has one
 * @property {boolean} [nearestSampling] as the filter's display config says
 * @property {object} [constants] JSON-serialisable values `setup` and `bind` may read
 * @property {(gl: WebGLRenderingContext, program: WebGLProgram, constants: object) => object} setup
 *     runs once after the program is linked and made current, with the
 *     framebuffer texture bound on unit 0; returns whatever `bind` needs
 * @property {(gl: WebGLRenderingContext, state: object, params: object) => void} bind
 *     runs before each draw with what the app's GlCanvas passes to
 *     `setUniforms`: `width`, `height`, `texelsPerOutputPixel`, plus the job's
 *     own `params` and decoded `bytes`
 */

/**
 * Lay a picture of logical pixels into a framebuffer the way the video chips
 * would, one logical pixel covering `texelsWide` by `texelsHigh` texels.
 *
 * The picture is surrounded by `padding` logical pixels of context, made by
 * repeating its edge pixels outwards, which is what sampling clamped to the
 * picture would have given: a shader that reads neighbours sees those rather
 * than whatever the framebuffer was initialised to. The innermost `margin` of
 * that context is drawn as well and cropped from the result, so the picture's
 * own edges are kept away from the quad's.
 *
 * @param {object} pattern
 * @param {string} pattern.name
 * @param {(string | string[])[]} pattern.rows one palette key per logical pixel,
 *     as a string of single-character keys or an array of keys of any length
 * @param {Object<string, number>} pattern.palette key to 0xAABBGGRR colour
 * @param {number} [pattern.texelsWide] as MODE 1 is two and MODE 2 is four
 * @param {number} [pattern.texelsHigh] 2 for the usual non-interlaced doubling
 * @param {number} [pattern.scale] output pixels per logical pixel
 * @param {number | {x: number, y: number}} [pattern.padding] logical pixels of
 *     context around the picture, per axis or the same for both
 * @param {number} [pattern.margin] of those, how many are drawn and cropped
 * @param {{x: number, y: number}} [pattern.origin] texel at which the padded
 *     picture starts, to place it elsewhere in the texture
 * @param {object} [pattern.params] JSON-serialisable values handed to the filter's `bind`
 * @param {Object<string, Uint8Array>} [pattern.bytes] byte arrays handed to `bind` alongside them
 * @returns {object} a job for {@link renderJobs}
 */
export function buildPattern({
    name,
    rows,
    palette,
    texelsWide = 1,
    texelsHigh = 1,
    scale = 1,
    padding = 0,
    margin = 0,
    origin = { x: 0, y: 0 },
    params = {},
    bytes = {},
}) {
    const pad = typeof padding === "number" ? { x: padding, y: padding } : padding;
    if (margin > Math.min(pad.x, pad.y)) throw new Error(`Pattern "${name}" draws a margin wider than its padding`);
    const width = rows[0].length;
    const height = rows.length;
    const clamp = (value, limit) => Math.min(limit - 1, Math.max(0, value));

    const paddedWidth = (width + 2 * pad.x) * texelsWide;
    const paddedHeight = (height + 2 * pad.y) * texelsHigh;
    const texelRows = origin.y + paddedHeight;
    if (origin.x + paddedWidth > TextureSize) throw new Error(`Pattern "${name}" is wider than the framebuffer`);
    if (texelRows > TextureSize) throw new Error(`Pattern "${name}" is taller than the framebuffer`);

    const fb32 = new Uint32Array(TextureSize * texelRows);
    for (let y = 0; y < height + 2 * pad.y; ++y) {
        const row = rows[clamp(y - pad.y, height)];
        for (let x = 0; x < width + 2 * pad.x; ++x) {
            const char = row[clamp(x - pad.x, width)];
            const colour = palette[char];
            if (colour === undefined) throw new Error(`Pattern "${name}" has no palette entry for "${char}"`);
            for (let dy = 0; dy < texelsHigh; ++dy)
                for (let dx = 0; dx < texelsWide; ++dx)
                    fb32[(origin.y + y * texelsHigh + dy) * TextureSize + origin.x + x * texelsWide + dx] = colour;
        }
    }

    return {
        name,
        width,
        height,
        scale,
        texelsWide,
        texelsHigh,
        fb32,
        // Every row built, not just those drawn: the rows outside the picture
        // are sampled by the ones inside it, and the texture is allocated once
        // and only ever refilled, so anything not uploaded holds the previous
        // pattern's pixels rather than nothing.
        texelRows,
        extent: {
            left: origin.x + (pad.x - margin) * texelsWide,
            right: origin.x + (width + pad.x + margin) * texelsWide,
            top: origin.y + (pad.y - margin) * texelsHigh,
            bottom: origin.y + (height + pad.y + margin) * texelsHigh,
        },
        outWidth: (width + 2 * margin) * scale,
        outHeight: (height + 2 * margin) * scale,
        crop: margin * scale,
        params,
        bytes,
    };
}

/**
 * Build a self-contained page that sets WebGL up as GlCanvas does, hands the
 * filter-specific part to the filter, draws every job, and reads the pixels
 * back. It has to be self-contained because it is handed to the page as
 * content: no module imports, no dev server.
 */
function buildHarness(filter, jobs) {
    const vert = readFileSync(new URL(filter.vert, ShaderDir), "utf8");
    const rawFrag = readFileSync(new URL(filter.frag, ShaderDir), "utf8");
    const frag = filter.prepareFragment ? filter.prepareFragment(rawFrag) : rawFrag;

    const toBase64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    // A method written in shorthand prints without the keyword that would make
    // it an expression.
    const inline = (fn) => {
        const source = fn.toString();
        return /^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(source) ? source : `function ${source}`;
    };
    // Ship only the framebuffer rows that were built, so the page stays small.
    const encoded = jobs.map((job) => ({
        name: job.name,
        extent: job.extent,
        rows: job.texelRows,
        outWidth: job.outWidth,
        outHeight: job.outHeight,
        params: job.params,
        fb: toBase64(job.fb32.subarray(0, TextureSize * job.texelRows)),
        bytes: Object.fromEntries(Object.entries(job.bytes).map(([key, value]) => [key, toBase64(value)])),
    }));

    return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>html, body { margin: 0; background: #000; }</style></head>
<body>
<canvas id="c"></canvas>
<script id="vert" type="x-shader">${vert}</script>
<script id="frag" type="x-shader">${frag}</script>
<script>
const TextureSize = ${TextureSize};
const constants = ${JSON.stringify(filter.constants ?? {})};
const setup = ${inline(filter.setup)};
const bind = ${inline(filter.bind)};
const jobs = ${JSON.stringify(encoded)};

function fromBase64(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) out[i] = binary.charCodeAt(i);
    return out;
}

function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; ++i) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function fail(message) {
    window.failure = message;
    throw new Error(message);
}
window.onerror = (message) => { window.failure = message; };

const canvas = document.getElementById("c");
// Unlike the app this does not set failIfMajorPerformanceCaveat: headless
// Chrome renders through SwiftShader, which that flag exists to reject.
const gl = canvas.getContext("webgl", {
    alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true, stencil: false,
});
if (!gl) fail("no webgl context");

function compile(type, source, name) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        fail(name + " shader: " + gl.getShaderInfoLog(shader));
    return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, document.getElementById("vert").textContent, "vertex"));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, document.getElementById("frag").textContent, "fragment"));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) fail("link: " + gl.getProgramInfoLog(program));
gl.useProgram(program);

// The framebuffer texture is a fixed size, as in GlCanvas: allocate once and
// refill it per job.
const sampling = ${filter.nearestSampling ? "gl.NEAREST" : "gl.LINEAR"};
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampling);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampling);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TextureSize, TextureSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

const posLoc = gl.getAttribLocation(program, "pos");
gl.enableVertexAttribArray(posLoc);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

const uvLoc = gl.getAttribLocation(program, "uvIn");
gl.enableVertexAttribArray(uvLoc);
const uvBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

const state = setup(gl, program, constants);

const results = {};
for (const job of jobs) {
    canvas.width = job.outWidth;
    canvas.height = job.outHeight;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TextureSize, job.rows, gl.RGBA, gl.UNSIGNED_BYTE, fromBase64(job.fb));

    const minx = job.extent.left / TextureSize, maxx = job.extent.right / TextureSize;
    const miny = job.extent.top / TextureSize, maxy = job.extent.bottom / TextureSize;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([minx, maxy, minx, miny, maxx, maxy, maxx, miny]), gl.STATIC_DRAW);

    const bytes = {};
    for (const key of Object.keys(job.bytes)) bytes[key] = fromBase64(job.bytes[key]);
    bind(gl, state, {
        width: TextureSize,
        height: TextureSize,
        texelsPerOutputPixel: (job.extent.right - job.extent.left) / gl.drawingBufferWidth,
        ...job.params,
        ...bytes,
    });

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) fail(job.name + ": gl error " + error);

    const pixels = new Uint8Array(job.outWidth * job.outHeight * 4);
    gl.readPixels(0, 0, job.outWidth, job.outHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    results[job.name] = toBase64(pixels);
}

window.results = results;
</script>
</body>
</html>`;
}

const ChromiumCandidates = ["chromium", "chromium-browser"];

/** Look a command up on PATH, as a shell would, without spawning one. */
function onPath(command) {
    return (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((dir) => path.join(dir, command))
        .find(existsSync);
}

/** A browser to render in: CHROME_PATH, else the system Chrome, else a Chromium from PATH. */
async function launchBrowser() {
    // Software WebGL; newer Chrome hides it behind the swiftshader flag.
    const options = { args: ["--disable-gpu", "--enable-unsafe-swiftshader"] };
    if (process.env.CHROME_PATH) return chromium.launch({ ...options, executablePath: process.env.CHROME_PATH });
    try {
        return await chromium.launch({ ...options, channel: "chrome" });
    } catch (error) {
        const chromiumPath = ChromiumCandidates.map(onPath).find(Boolean);
        if (!chromiumPath)
            throw new Error(
                `No browser for the shader tests: launching the system Chrome failed ` +
                    `(${error.message.split("\n")[0]}), and none of ${ChromiumCandidates.join(", ")} is on PATH. ` +
                    `Install Chrome or Chromium, or set CHROME_PATH to a browser executable.`,
                { cause: error },
            );
        return chromium.launch({ ...options, executablePath: chromiumPath });
    }
}

/**
 * Draw every job through the filter and return its pixels.
 *
 * @param {FilterHarness} filter
 * @param {object[]} jobs from {@link buildPattern}
 * @returns {Promise<Object<string, {width: number, height: number, data: Uint8Array}>>}
 *     RGBA rows, top row first
 */
export async function renderJobs(filter, jobs) {
    const browser = await launchBrowser();
    try {
        const page = await browser.newPage();
        await page.setContent(buildHarness(filter, jobs));
        const { failure, raw } = await page.evaluate(() => ({ failure: window.failure, raw: window.results }));
        if (failure) throw new Error(`WebGL harness failed: ${failure}`);
        if (!raw) throw new Error("WebGL harness did not finish; no results in the page");

        const images = {};
        for (const job of jobs) {
            if (!(job.name in raw)) throw new Error(`WebGL harness returned no pixels for "${job.name}"`);
            const drawn = flipVertically(Buffer.from(raw[job.name], "base64"), job.outWidth, job.outHeight);
            images[job.name] = crop(drawn, job.crop);
        }
        return images;
    } finally {
        await browser.close();
    }
}

/** One output pixel as [r, g, b, a]. */
export function pixelAt(image, x, y) {
    const offset = (y * image.width + x) * 4;
    return [...image.data.subarray(offset, offset + 4)];
}

/** Every output pixel, as [r, g, b, a]. */
export function* eachPixel(image) {
    for (let i = 0; i < image.width * image.height; ++i) yield [...image.data.subarray(i * 4, i * 4 + 4)];
}

/** Take the margin off all four sides, leaving the picture that was asked for. */
function crop(image, margin) {
    const width = image.width - 2 * margin;
    const height = image.height - 2 * margin;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; ++y) {
        const from = ((y + margin) * image.width + margin) * 4;
        data.set(image.data.subarray(from, from + width * 4), y * width * 4);
    }
    return { width, height, data };
}

/** readPixels hands back the bottom row first; everything here counts from the top. */
function flipVertically(bytes, width, height) {
    const stride = width * 4;
    const data = new Uint8Array(stride * height);
    for (let y = 0; y < height; ++y)
        data.set(bytes.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
    return { width, height, data };
}
