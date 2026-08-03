"use strict";

// Times each display filter over a real captured frame, so a change to a
// shader can be weighed rather than guessed at.
//
//   node tools/benchmark-filters.js [--scene NAME] [--frames N] [--size WxH ...]
//
// Chrome falls back to SwiftShader when it cannot reach a GPU, in which case
// the absolute numbers mean nothing — but the ratios still track the fragments
// times ALU we are trying to reduce. The renderer is printed so you know which
// you got.

import { ArgumentParser } from "argparse";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { captureScene, Scenes, FbWidth } from "./upscale-scenes.js";
import { LineGridRows } from "../src/video-filters/pixel-grid.js";

const parser = new ArgumentParser({ description: "Time jsbeeb's display filters" });
parser.add_argument("--scene", { default: "mode1-diagonals" });
parser.add_argument("--frames", { type: "int", default: 60 });
parser.add_argument("--size", { action: "append", help: "output size as WxH; repeatable" });
parser.add_argument("--filter", { action: "append", help: "only time these filters; repeatable" });
const args = parser.parse_args();

const sceneName = args.scene;
const frames = args.frames;
const scene = Scenes.find((s) => s.name === sceneName);
if (!scene) throw new Error(`No scene named "${sceneName}"; try ${Scenes.map((s) => s.name).join(", ")}`);

const shaderDir = new URL("../src/video-filters/shaders/", import.meta.url);
const shader = (name) => readFileSync(new URL(name, shaderDir), "utf8");

async function main() {
    const { frame, extent } = await captureScene(scene);

    // Each variant is a fragment shader plus the uniforms it wants.
    const allVariants = [
        { name: "passthrough", vert: "passthrough.vert.glsl", frag: "passthrough.frag.glsl", kind: "passthrough" },
        { name: "pal", vert: "pal-composite.vert.glsl", frag: "pal-composite.frag.glsl", kind: "pal" },
        { name: "xbr", vert: "xbr.vert.glsl", frag: "xbr.frag.glsl", kind: "xbr" },
    ];
    const variants = args.filter ? allVariants.filter((v) => args.filter.includes(v.name)) : allVariants;
    if (variants.length === 0)
        throw new Error(
            `No filter named "${args.filter.join(", ")}"; try ${allVariants.map((v) => v.name).join(", ")}`,
        );

    const sizes = (args.size ?? ["896x600", "1792x1200"]).map((size) => {
        const match = /^(\d+)x(\d+)$/.exec(size);
        if (!match) throw new Error(`Bad --size "${size}"; want WxH`);
        return [Number(match[1]), Number(match[2])];
    });

    const fbBase64 = Buffer.from(new Uint8Array(frame.fb32.buffer, 0, FbWidth * extent.bottom * 4)).toString("base64");
    const lineGridBase64 = Buffer.from(frame.lineGrid).toString("base64");

    const cases = [];
    for (const [w, h] of sizes) for (const v of variants) cases.push({ ...v, width: w, height: h });

    // Chrome reports nothing until the whole run finishes, so say what is coming.
    // PAL at a large size is far and away the slowest thing here.
    console.log(
        `timing ${cases.length} cases at ${frames} frames each: ` +
            `${variants.map((v) => v.name).join(", ")} at ${sizes.map(([w, h]) => `${w}x${h}`).join(", ")}`,
    );
    if (variants.some((v) => v.kind === "pal") && sizes.some(([w]) => w > 1000))
        console.log("(PAL at that size is the slow one; --filter xbr skips it)");

    const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<canvas id="c"></canvas>
<script>
const TextureSize = ${LineGridRows};
const extent = ${JSON.stringify(extent)};
const CASES = ${JSON.stringify(cases.map((c) => ({ ...c, vertSrc: shader(c.vert), fragSrc: shader(c.frag) })))};
const FRAMES = ${frames};

function fromBase64(t) { const b = atob(t), o = new Uint8Array(b.length); for (let i=0;i<b.length;++i) o[i]=b.charCodeAt(i); return o; }
const fbBytes = fromBase64("${fbBase64}");
const lineGrid = fromBase64("${lineGridBase64}");
const fb8 = new Uint8Array(TextureSize * TextureSize * 4);
fb8.set(fbBytes);

const results = [];
for (const c of CASES) {
    const canvas = document.createElement("canvas");
    canvas.width = c.width; canvas.height = c.height;
    const gl = canvas.getContext("webgl", {alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
    if (!gl) { results.push({...c, error: "no context"}); continue; }
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(c.name + ": " + gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, c.vertSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, c.fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(c.name + " link: " + gl.getProgramInfoLog(p));
    gl.useProgram(p);
    gl.viewport(0, 0, c.width, c.height);

    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const [k, v] of [["TEXTURE_WRAP_S","CLAMP_TO_EDGE"],["TEXTURE_WRAP_T","CLAMP_TO_EDGE"],
                          ["TEXTURE_MAG_FILTER", c.kind === "xbr" ? "NEAREST" : "LINEAR"],
                          ["TEXTURE_MIN_FILTER", c.kind === "xbr" ? "NEAREST" : "LINEAR"]])
        gl.texParameteri(gl.TEXTURE_2D, gl[k], gl[v]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TextureSize, TextureSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, fb8);

    if (c.kind === "xbr") {
        const gt = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, gt);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        for (const k of ["TEXTURE_WRAP_S","TEXTURE_WRAP_T"]) gl.texParameteri(gl.TEXTURE_2D, gl[k], gl.CLAMP_TO_EDGE);
        for (const k of ["TEXTURE_MAG_FILTER","TEXTURE_MIN_FILTER"]) gl.texParameteri(gl.TEXTURE_2D, gl[k], gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, TextureSize, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, lineGrid);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(gl.getUniformLocation(p, "lineGrid"), 1);
        gl.uniform2f(gl.getUniformLocation(p, "uTextureSize"), TextureSize, TextureSize);
        gl.uniform1f(gl.getUniformLocation(p, "uTexelsPerOutputPixel"), (extent.right - extent.left) / c.width);
    }
    gl.uniform1i(gl.getUniformLocation(p, "tex"), 0);
    gl.uniform1i(gl.getUniformLocation(p, "uFramebuffer"), 0);
    gl.uniform2f(gl.getUniformLocation(p, "uResolution"), TextureSize, TextureSize);
    gl.uniform2f(gl.getUniformLocation(p, "uTexelSize"), 1/TextureSize, 1/TextureSize);
    gl.uniform1f(gl.getUniformLocation(p, "uFrameCount"), 0);

    const posLoc = gl.getAttribLocation(p, "pos");
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0,0,1,1,0,1,1]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    const minx=extent.left/TextureSize, maxx=extent.right/TextureSize, miny=extent.top/TextureSize, maxy=extent.bottom/TextureSize;
    const uvLoc = gl.getAttribLocation(p, "uvIn");
    gl.enableVertexAttribArray(uvLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([minx,maxy,minx,miny,maxx,maxy,maxx,miny]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

    // Warm up, then time. readPixels forces the draw to complete.
    const probe = new Uint8Array(4);
    for (let i = 0; i < 5; ++i) { gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,probe); }
    const start = performance.now();
    for (let i = 0; i < FRAMES; ++i) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, extent.top, TextureSize, extent.bottom - extent.top, gl.RGBA, gl.UNSIGNED_BYTE,
            fb8.subarray(extent.top * TextureSize * 4, extent.bottom * TextureSize * 4));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,probe);
    }
    const ms = (performance.now() - start) / FRAMES;
    results.push({ name: c.name, width: c.width, height: c.height, msPerFrame: +ms.toFixed(3) });
}
const probeCanvas = document.createElement("canvas");
const probeGl = probeCanvas.getContext("webgl");
const dbg = probeGl.getExtension("WEBGL_debug_renderer_info");
const renderer = dbg ? probeGl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : probeGl.getParameter(probeGl.RENDERER);
document.title = "RESULTS" + JSON.stringify({ renderer, results });
</script></body></html>`;

    const dir = mkdtempSync(path.join(tmpdir(), "jsbeeb-bench-"));
    const pageFile = path.join(dir, "bench.html");
    writeFileSync(pageFile, page);
    try {
        const dom = execFileSync(
            "google-chrome",
            [
                "--headless",
                "--disable-gpu",
                "--enable-unsafe-swiftshader",
                "--virtual-time-budget=600000",
                "--dump-dom",
                pageFile,
            ],
            { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 900000 },
        );
        const match = /<title>RESULTS(.*?)<\/title>/s.exec(dom);
        if (!match) {
            console.error(dom.slice(0, 2000));
            throw new Error("The benchmark page did not report results");
        }
        const { renderer, results } = JSON.parse(match[1]);
        console.log(`scene ${sceneName}, ${frames} frames each`);
        console.log(`renderer: ${renderer}\n`);
        const base = results[0].msPerFrame;
        for (const r of results)
            console.log(
                `  ${r.name.padEnd(12)} ${String(r.width).padStart(5)}x${String(r.height).padEnd(5)} ` +
                    `${String(r.msPerFrame).padStart(8)} ms/frame   ${(r.msPerFrame / base).toFixed(1)}x the cheapest`,
            );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(`\nERROR: ${error.stack ?? error.message ?? error}`);
    process.exit(1);
});
