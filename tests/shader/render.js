"use strict";

// Renders patterns through the real xBR GLSL in headless Chrome and hands the
// pixels back, so the shader itself can be asserted on.
//
// Node has no WebGL, so the only way to execute the shader is to give it to a
// browser. Every pattern in a run is drawn by a single Chrome invocation:
// launching one costs far more than drawing into it.

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { encodeLineGrid, LineGridRows } from "../../src/video-filters/pixel-grid.js";

/** Framebuffer stride, and the size of the square GL texture it is uploaded into. */
const FbWidth = LineGridRows;

/**
 * Logical pixels drawn around the picture and then cropped off. The last row of
 * fragments in a drawn quad picks up a blend even where the picture either side
 * of it is uniform, so the picture's own edges are kept away from the quad's.
 */
const Margin = 1;

/**
 * Logical pixels of context each pattern is surrounded by. xBR reads a 5x5
 * neighbourhood, so everything drawn — the margin included — needs two more
 * beyond it.
 */
const Padding = Margin + 2;

const ChromeCandidates = ["google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser"];

let chromePath = null;

/** Look a command up on PATH, as a shell would, without spawning one. */
function onPath(command) {
    // Windows needs the extension supplying; everywhere else the name is whole.
    const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        for (const suffix of suffixes) {
            const candidate = path.join(dir, command + suffix);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

function findChrome() {
    if (chromePath) return chromePath;
    chromePath = process.env.CHROME_PATH || ChromeCandidates.map(onPath).find(Boolean);
    if (!chromePath)
        throw new Error(
            `No Chrome found on PATH (looked for ${ChromeCandidates.join(", ")}). Install Chrome or ` +
                `Chromium, or set CHROME_PATH to the browser's executable.`,
        );
    return chromePath;
}

/**
 * Lay a picture of logical pixels into a framebuffer the way the video chips
 * would, one logical pixel covering `texelsWide` by `texelsHigh` texels, and
 * describe it in a line grid the shader can read.
 *
 * @param {object} pattern
 * @param {string[]} pattern.rows one character per logical pixel
 * @param {Object<string, number>} pattern.palette character to 0xAABBGGRR colour
 * @param {number} [pattern.texelsWide] as MODE 1 is two and MODE 2 is four
 * @param {number} [pattern.texelsHigh] 2 for the usual non-interlaced doubling
 * @param {number} [pattern.scale] output pixels per logical pixel
 * @returns {object} a job for {@link renderPatterns}
 */
export function buildPattern({ name, rows, palette, texelsWide = 1, texelsHigh = 1, scale = 4 }) {
    const width = rows[0].length;
    const height = rows.length;
    const clamp = (value, limit) => Math.min(limit - 1, Math.max(0, value));

    // xBR reads a 5x5 neighbourhood, so the outermost pixel of the picture
    // needs two more beyond it. On screen those are the rest of the framebuffer;
    // here they have to be supplied, or the picture's own edges would be
    // reconstructed against whatever the framebuffer was initialised to. Repeat
    // the edge pixels outwards, which is what sampling clamped to the picture
    // would have given.
    const texelRows = (height + 2 * Padding) * texelsHigh;
    const fb32 = new Uint32Array(FbWidth * texelRows);
    for (let y = 0; y < height + 2 * Padding; ++y) {
        const row = rows[clamp(y - Padding, height)];
        for (let x = 0; x < width + 2 * Padding; ++x) {
            const char = row[clamp(x - Padding, width)];
            const colour = palette[char];
            if (colour === undefined) throw new Error(`Pattern "${name}" has no palette entry for "${char}"`);
            for (let dy = 0; dy < texelsHigh; ++dy)
                for (let dx = 0; dx < texelsWide; ++dx)
                    fb32[(y * texelsHigh + dy) * FbWidth + x * texelsWide + dx] = colour;
        }
    }

    const lineGrid = new Uint8Array(LineGridRows);
    lineGrid.fill(encodeLineGrid(texelsWide, texelsHigh === 2), 0, texelRows);

    return {
        name,
        width,
        height,
        scale,
        fb32,
        lineGrid,
        // The picture plus its margin is drawn; the rest of the padding is
        // there to be sampled.
        extent: {
            left: (Padding - Margin) * texelsWide,
            right: (width + Padding + Margin) * texelsWide,
            top: (Padding - Margin) * texelsHigh,
            bottom: (height + Padding + Margin) * texelsHigh,
        },
        outWidth: (width + 2 * Margin) * scale,
        outHeight: (height + 2 * Margin) * scale,
    };
}

/**
 * Build a self-contained page that sets WebGL up exactly as GlCanvas and
 * XbrFilter do, draws every job, and reads the pixels back. It has to be
 * self-contained because it is loaded over file:// — no module imports, no dev
 * server.
 */
function buildHarness(jobs) {
    const shaderDir = new URL("../../src/video-filters/shaders/", import.meta.url);
    const vert = readFileSync(new URL("xbr.vert.glsl", shaderDir), "utf8");
    const frag = readFileSync(new URL("xbr.frag.glsl", shaderDir), "utf8");

    // Ship only the framebuffer rows that can matter, so the page stays small.
    const encoded = jobs.map((job) => ({
        name: job.name,
        extent: job.extent,
        outWidth: job.outWidth,
        outHeight: job.outHeight,
        fb: Buffer.from(job.fb32.buffer, 0, FbWidth * job.extent.bottom * 4).toString("base64"),
        lineGrid: Buffer.from(job.lineGrid).toString("base64"),
    }));

    return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>html, body { margin: 0; background: #000; }</style></head>
<body>
<canvas id="c"></canvas>
<script id="vert" type="x-shader">${vert}</script>
<script id="frag" type="x-shader">${frag}</script>
<script>
const TextureSize = ${FbWidth};
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
    document.title = "FAIL: " + message;
    throw new Error(message);
}

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

function makeTexture(unit) {
    const texture = gl.createTexture();
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    return texture;
}

// Both textures are a fixed size, as in GlCanvas and XbrFilter: allocate once
// and refill them per job.
makeTexture(gl.TEXTURE0);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TextureSize, TextureSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
makeTexture(gl.TEXTURE1);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, ${LineGridRows}, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
gl.activeTexture(gl.TEXTURE0);

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

gl.uniform1i(gl.getUniformLocation(program, "tex"), 0);
gl.uniform1i(gl.getUniformLocation(program, "lineGrid"), 1);
gl.uniform2f(gl.getUniformLocation(program, "uTextureSize"), TextureSize, TextureSize);
gl.uniform2f(gl.getUniformLocation(program, "uTexelSize"), 1 / TextureSize, 1 / TextureSize);
const perPixelLoc = gl.getUniformLocation(program, "uTexelsPerOutputPixel");

const results = {};
for (const job of jobs) {
    canvas.width = job.outWidth;
    canvas.height = job.outHeight;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    const rows = job.extent.bottom;
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TextureSize, rows, gl.RGBA, gl.UNSIGNED_BYTE, fromBase64(job.fb));

    gl.activeTexture(gl.TEXTURE1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ${LineGridRows}, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE,
        fromBase64(job.lineGrid));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);

    const minx = job.extent.left / TextureSize, maxx = job.extent.right / TextureSize;
    const miny = job.extent.top / TextureSize, maxy = job.extent.bottom / TextureSize;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([minx, maxy, minx, miny, maxx, maxy, maxx, miny]), gl.STATIC_DRAW);
    gl.uniform1f(perPixelLoc, (job.extent.right - job.extent.left) / gl.drawingBufferWidth);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) fail(job.name + ": gl error " + error);

    const pixels = new Uint8Array(job.outWidth * job.outHeight * 4);
    gl.readPixels(0, 0, job.outWidth, job.outHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    results[job.name] = toBase64(pixels);
}

const out = document.createElement("script");
out.type = "application/json";
out.id = "results";
out.textContent = JSON.stringify(results);
document.body.appendChild(out);
document.title = "OK";
</script>
</body>
</html>`;
}

/**
 * Draw every pattern and return its pixels.
 *
 * @param {object[]} jobs from {@link buildPattern}
 * @returns {Object<string, {width: number, height: number, data: Uint8Array}>}
 *     RGBA rows, top row first
 */
export function renderPatterns(jobs) {
    const chrome = findChrome();
    const dir = mkdtempSync(path.join(tmpdir(), "jsbeeb-xbr-"));
    const pageFile = path.join(dir, "harness.html");
    writeFileSync(pageFile, buildHarness(jobs));
    try {
        // --dump-dom comes back on stdout, and the harness puts any WebGL
        // failure in the title, so a shader that will not compile says so
        // rather than quietly producing no pixels.
        const dom = execFileSync(
            chrome,
            [
                "--headless",
                "--disable-gpu",
                // Chrome cannot set up its sandbox in most CI containers.
                "--no-sandbox",
                // Software WebGL; newer Chrome hides it behind this flag.
                "--enable-unsafe-swiftshader",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                "--dump-dom",
                "--virtual-time-budget=10000",
                pageFile,
            ],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 120000,
                // The page carries every pattern's pixels back in its DOM.
                maxBuffer: 256 * 1024 * 1024,
            },
        );
        const failure = /<title>FAIL: ([^<]*)<\/title>/.exec(dom);
        if (failure) throw new Error(`WebGL harness failed: ${failure[1]}`);
        const json = /<script type="application\/json" id="results">(.*?)<\/script>/s.exec(dom);
        if (!json) throw new Error("WebGL harness did not finish; no results in the page");

        const raw = JSON.parse(json[1]);
        const images = {};
        for (const job of jobs) {
            if (!(job.name in raw)) throw new Error(`WebGL harness returned no pixels for "${job.name}"`);
            const drawn = flipVertically(Buffer.from(raw[job.name], "base64"), job.outWidth, job.outHeight);
            images[job.name] = crop(drawn, Margin * job.scale);
        }
        return images;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
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
