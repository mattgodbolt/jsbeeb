"use strict";

// Renders a captured BBC frame through the real xBR GLSL in headless Chrome and
// compares it against src/video-filters/xbr.js, the unit-tested JavaScript
// reference. Node has no WebGL, so this is the only way to find out whether the
// shader compiles at all, let alone whether it agrees with the reference.
//
//   node tools/verify-xbr-shader.js [--scene NAME] [--keep] [--out DIR]
//
// Exits non-zero if the shader fails to compile or the two implementations
// disagree by more than a rounding error.

import { ArgumentParser } from "argparse";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";
import pixelmatch from "pixelmatch";

import { captureScene, Scenes, FbWidth } from "./upscale-scenes.js";
import { findBands, extractBand, LineGridRows } from "../src/video-filters/pixel-grid.js";
import { xbrUpscale, makePixelImage } from "../src/video-filters/xbr.js";

const ChromeCandidates = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** Colour channels differing by more than this are treated as a real mismatch. */
const ChannelTolerance = 0.06;
/** Fraction of pixels allowed to differ, for the edges the two treat differently. */
const MaxDifferingFraction = 0.002;

function findChrome() {
    for (const candidate of ChromeCandidates) {
        try {
            return execFileSync("which", [candidate], { encoding: "utf8" }).trim();
        } catch {
            // Try the next one.
        }
    }
    throw new Error(`No Chrome found; looked for ${ChromeCandidates.join(", ")}`);
}

/**
 * Build a self-contained page that sets up WebGL exactly as GlCanvas and
 * XbrFilter do, and draws one frame. It has to be self-contained because it is
 * loaded over file:// — no module imports, no dev server.
 */
function buildHarness(frame, extent, outWidth, outHeight) {
    const shaderDir = new URL("../src/video-filters/shaders/", import.meta.url);
    const vert = readFileSync(new URL("xbr.vert.glsl", shaderDir), "utf8");
    const frag = readFileSync(new URL("xbr.frag.glsl", shaderDir), "utf8");

    // The GL texture is 1024 square, as in canvas.js; ship only the rows that
    // can matter so the page stays a sane size.
    const textureSize = LineGridRows;
    const fbBytes = Buffer.from(new Uint8Array(frame.fb32.buffer, 0, FbWidth * extent.bottom * 4));
    const fbBase64 = fbBytes.toString("base64");
    const lineGridBase64 = Buffer.from(frame.lineGrid).toString("base64");

    return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; }
  canvas { display: block; }
</style></head>
<body>
<canvas id="c" width="${outWidth}" height="${outHeight}"></canvas>
<script id="vert" type="x-shader">${vert}</script>
<script id="frag" type="x-shader">${frag}</script>
<script>
const TextureSize = ${textureSize};
const FbWidth = ${FbWidth};
const extent = ${JSON.stringify(extent)};

function fromBase64(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) out[i] = binary.charCodeAt(i);
    return out;
}

function fail(message) {
    document.title = "FAIL: " + message;
    const pre = document.createElement("pre");
    pre.style.color = "#f00";
    pre.textContent = message;
    document.body.appendChild(pre);
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
gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

// Framebuffer texture, unit 0 — same parameters as GlCanvas with nearestSampling.
const fbBytes = fromBase64("${fbBase64}");
const fb8 = new Uint8Array(TextureSize * TextureSize * 4);
fb8.set(fbBytes);
const texture = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TextureSize, TextureSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, fb8);

// Line grid texture, unit 1 — same as XbrFilter.
const lineGrid = fromBase64("${lineGridBase64}");
const gridTexture = gl.createTexture();
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, gridTexture);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, ${LineGridRows}, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, lineGrid);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
gl.activeTexture(gl.TEXTURE0);

// Geometry and texture coordinates, as GlCanvas builds them.
const posLoc = gl.getAttribLocation(program, "pos");
gl.enableVertexAttribArray(posLoc);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

const minx = extent.left / TextureSize, maxx = extent.right / TextureSize;
const miny = extent.top / TextureSize, maxy = extent.bottom / TextureSize;
const uvLoc = gl.getAttribLocation(program, "uvIn");
gl.enableVertexAttribArray(uvLoc);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([minx, maxy, minx, miny, maxx, maxy, maxx, miny]), gl.STATIC_DRAW);
gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

gl.uniform1i(gl.getUniformLocation(program, "tex"), 0);
gl.uniform1i(gl.getUniformLocation(program, "lineGrid"), 1);
gl.uniform2f(gl.getUniformLocation(program, "uTextureSize"), TextureSize, TextureSize);
gl.uniform2f(gl.getUniformLocation(program, "uTexelSize"), 1 / TextureSize, 1 / TextureSize);
gl.uniform1f(gl.getUniformLocation(program, "uTexelsPerOutputPixel"),
    (extent.right - extent.left) / gl.drawingBufferWidth);

gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
const error = gl.getError();
if (error !== gl.NO_ERROR) fail("gl error " + error);
document.title = "OK";
</script>
</body>
</html>`;
}

/** Run the harness in headless Chrome and return the rendered PNG. */
function renderInChrome(html, outWidth, outHeight, keep) {
    const chrome = findChrome();
    const dir = mkdtempSync(path.join(tmpdir(), "jsbeeb-xbr-"));
    const pageFile = path.join(dir, "harness.html");
    const shotFile = path.join(dir, "shot.png");
    writeFileSync(pageFile, html);
    try {
        // --dump-dom comes back on stdout, and the harness puts any WebGL
        // failure in the title, so a shader that will not compile is reported
        // as such rather than silently screenshotting an error page.
        const dom = execFileSync(
            chrome,
            [
                "--headless",
                "--disable-gpu",
                // Software WebGL; newer Chrome hides it behind this flag.
                "--enable-unsafe-swiftshader",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                `--window-size=${outWidth},${outHeight}`,
                `--screenshot=${shotFile}`,
                "--dump-dom",
                "--virtual-time-budget=5000",
                pageFile,
            ],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 120000,
                // --dump-dom hands back the whole page, and the page carries a
                // base64 copy of the framebuffer.
                maxBuffer: 256 * 1024 * 1024,
            },
        );
        const failure = /<title>FAIL: ([^<]*)<\/title>/.exec(dom);
        if (failure) throw new Error(`WebGL harness failed: ${failure[1]}`);
        if (!/<title>OK<\/title>/.test(dom)) throw new Error("WebGL harness did not finish");
        return readFileSync(shotFile);
    } finally {
        if (keep) console.log(`  harness kept at ${pageFile}`);
        else rmSync(dir, { recursive: true, force: true });
    }
}

/** Run the JavaScript reference over the same frame and extent. */
function referenceRender(frame, extent, outWidth, outHeight) {
    const bands = findBands(frame.lineGrid, extent.top, extent.bottom);
    if (bands.length !== 1) throw new Error(`expected a single-mode frame, found ${bands.length} bands`);
    const logical = extractBand(frame.fb32, FbWidth, bands[0], extent.left, extent.right);
    const out = makePixelImage(outWidth, outHeight);
    xbrUpscale(logical, out);
    return out;
}

/** pixelmatch and sharp both want four channels here. */
function toRgbaBuffer(image) {
    const buffer = Buffer.allocUnsafe(image.width * image.height * 4);
    for (let i = 0; i < image.width * image.height; ++i) {
        const word = image.data[i];
        buffer[i * 4] = word & 0xff;
        buffer[i * 4 + 1] = (word >>> 8) & 0xff;
        buffer[i * 4 + 2] = (word >>> 16) & 0xff;
        buffer[i * 4 + 3] = 0xff;
    }
    return buffer;
}

async function verifyScene(scene, opts) {
    console.log(`\n${scene.name}: ${scene.description}`);
    const { frame, extent } = await captureScene(scene, opts.model);

    const bands = findBands(frame.lineGrid, extent.top, extent.bottom);
    if (bands.length !== 1) {
        console.log(`  skipped: ${bands.length} bands, and the reference maps only one to the full output`);
        return true;
    }
    // Whole logical pixels only, so the two implementations sample the same grid.
    const logicalWidth = Math.floor((extent.right - extent.left) / bands[0].texelsWide);
    const outWidth = logicalWidth * 2;
    const outHeight = Math.floor((extent.bottom - extent.top) / bands[0].texelsHigh) * 2;
    console.log(`  rendering ${outWidth}x${outHeight} from a ${logicalWidth}-pixel-wide band`);

    const shaderPng = renderInChrome(buildHarness(frame, extent, outWidth, outHeight), outWidth, outHeight, opts.keep);
    const shaderRaw = await sharp(shaderPng).ensureAlpha().raw().toBuffer();
    const referenceRaw = toRgbaBuffer(referenceRender(frame, extent, outWidth, outHeight));

    const diff = Buffer.alloc(outWidth * outHeight * 4);
    const differing = pixelmatch(referenceRaw, shaderRaw, diff, outWidth, outHeight, {
        threshold: ChannelTolerance,
        includeAA: false,
    });
    const fraction = differing / (outWidth * outHeight);
    const ok = fraction <= MaxDifferingFraction;
    console.log(
        `  ${differing} of ${outWidth * outHeight} pixels differ (${(fraction * 100).toFixed(3)}%) — ${ok ? "OK" : "FAILED"}`,
    );

    if (opts.out) {
        mkdirSync(opts.out, { recursive: true });
        const raw = { width: outWidth, height: outHeight, channels: 4 };
        await sharp(shaderRaw, { raw })
            .png()
            .toFile(path.join(opts.out, `${scene.name}-shader.png`));
        await sharp(referenceRaw, { raw })
            .png()
            .toFile(path.join(opts.out, `${scene.name}-reference.png`));
        if (!ok)
            await sharp(diff, { raw })
                .png()
                .toFile(path.join(opts.out, `${scene.name}-diff.png`));
    }
    return ok;
}

async function main() {
    const parser = new ArgumentParser({ description: "Check the xBR shader against the JS reference" });
    parser.add_argument("--scene", { help: "verify only the named scene" });
    parser.add_argument("--model", { default: "B-DFS1.2" });
    parser.add_argument("--out", { default: "out/xbr-verify", help: "where to write the rendered images" });
    parser.add_argument("--keep", { action: "store_true", help: "keep the generated harness page" });
    const args = parser.parse_args();

    const scenes = args.scene ? Scenes.filter((s) => s.name === args.scene) : Scenes;
    if (scenes.length === 0) throw new Error(`No scene named "${args.scene}"`);

    let allOk = true;
    for (const scene of scenes) {
        allOk = (await verifyScene(scene, args)) && allOk;
    }
    console.log(allOk ? "\nShader matches the reference implementation." : "\nShader does NOT match the reference.");
    if (!allOk) process.exitCode = 1;
}

main().catch((error) => {
    console.error(`\nERROR: ${error.stack ?? error.message ?? error}`);
    process.exit(1);
});
