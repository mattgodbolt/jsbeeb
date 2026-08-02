"use strict";

// Renders test screens on a real emulated BBC and writes side-by-side PNGs
// comparing how the picture is scaled to the display:
//
//   bilinear — what jsbeeb does today (the raster stretched by the GPU)
//   nearest  — the same raster, point sampled
//   xbr      — the logical pixel grid recovered and upscaled with xBR-lv2
//
// The point is to answer "would this actually look better?" without needing a
// browser. Run with:
//
//   node tools/upscale-preview.js [--out DIR] [--scene NAME] [--width N]

import { ArgumentParser } from "argparse";
import { mkdirSync } from "fs";
import path from "path";
import sharp from "sharp";

import { captureScene, Scenes, FbWidth, CanvasWidth, CanvasHeight } from "./upscale-scenes.js";
import { findBands, extractBand } from "../src/video-filters/pixel-grid.js";
import { xbrUpscale, makePixelImage } from "../src/video-filters/xbr.js";

/** Convert a packed-word image into a raw RGB buffer for sharp. */
function toRgbBuffer(image) {
    const buffer = Buffer.allocUnsafe(image.width * image.height * 3);
    for (let i = 0; i < image.width * image.height; ++i) {
        const word = image.data[i];
        buffer[i * 3] = word & 0xff;
        buffer[i * 3 + 1] = (word >>> 8) & 0xff;
        buffer[i * 3 + 2] = (word >>> 16) & 0xff;
    }
    return sharp(buffer, { raw: { width: image.width, height: image.height, channels: 3 } });
}

/** Crop the framebuffer to `extent` as an image, with no rescaling. */
function cropRaster(frame, extent) {
    const width = extent.right - extent.left;
    const height = extent.bottom - extent.top;
    const image = makePixelImage(width, height);
    for (let y = 0; y < height; ++y) {
        image.data.set(
            frame.fb32.subarray((extent.top + y) * FbWidth + extent.left, (extent.top + y) * FbWidth + extent.right),
            y * width,
        );
    }
    return image;
}

/**
 * Upscale a frame with xBR, band by band. Each band is converted to logical
 * pixels, upscaled to the slice of the output it occupies, and composited back.
 */
function xbrFrame(frame, extent, outWidth, outHeight, options) {
    const bands = findBands(frame.lineGrid, extent.top, extent.bottom);
    const out = makePixelImage(outWidth, outHeight);
    const totalRows = extent.bottom - extent.top;
    const report = [];
    for (const band of bands) {
        const logical = extractBand(frame.fb32, FbWidth, band, extent.left, extent.right);
        if (logical.width === 0 || logical.height === 0) continue;
        // The band occupies the same fraction of the output as of the input.
        const outTop = Math.round(((band.top - extent.top) / totalRows) * outHeight);
        const outBottom = Math.round(((band.bottom - extent.top) / totalRows) * outHeight);
        const slice = makePixelImage(outWidth, Math.max(1, outBottom - outTop));
        xbrUpscale(logical, slice, options);
        out.data.set(slice.data, outTop * outWidth);
        report.push(
            `${band.top}-${band.bottom} (${band.texelsWide}x${band.texelsHigh} texels/pixel) ` +
                `-> ${logical.width}x${logical.height} logical`,
        );
    }
    return { image: out, report };
}

const LabelHeight = 28;
const Background = { r: 17, g: 17, b: 17 };

const caption = (text, width) =>
    Buffer.from(
        `<svg width="${width}" height="${LabelHeight}">` +
            `<rect width="100%" height="100%" fill="#111"/>` +
            `<text x="8" y="20" font-family="monospace" font-size="16" fill="#eee">${text}</text>` +
            `</svg>`,
    );

/** Stack the variants vertically with captions so they can be flicked between. */
async function writeComparison(variants, outFile, title) {
    const width = variants[0].image.width;
    const panels = [];
    let y = 0;
    for (const variant of variants) {
        panels.push({ input: caption(variant.label, width), top: y, left: 0 });
        y += LabelHeight;
        panels.push({ input: await toRgbBuffer(variant.image).png().toBuffer(), top: y, left: 0 });
        y += variant.image.height;
    }
    await sharp({ create: { width, height: y, channels: 3, background: Background } })
        .composite(panels)
        .png()
        .toFile(outFile);
    console.log(`  wrote ${outFile} (${width}x${y})`);
    return title;
}

/**
 * Write the same small region from each variant side by side, magnified with
 * nearest-neighbour. The full-size comparison shows whether a scene looks
 * right; this is what shows *why*.
 */
async function writeDetail(variants, detail, outFile) {
    const { left, top, width, height, zoom = 3 } = detail;
    const cellWidth = width * zoom;
    const gap = 8;
    const panels = [];
    for (const [index, variant] of variants.entries()) {
        const x = index * (cellWidth + gap);
        panels.push({ input: caption(variant.label, cellWidth), top: 0, left: x });
        panels.push({
            input: await toRgbBuffer(variant.image)
                .extract({ left, top, width, height })
                .resize(cellWidth, height * zoom, { kernel: "nearest" })
                .png()
                .toBuffer(),
            top: LabelHeight,
            left: x,
        });
    }
    await sharp({
        create: {
            width: variants.length * (cellWidth + gap) - gap,
            height: height * zoom + LabelHeight,
            channels: 3,
            background: Background,
        },
    })
        .composite(panels)
        .png()
        .toFile(outFile);
    console.log(`  wrote ${outFile} (detail at ${left},${top} magnified ${zoom}x)`);
}

async function runScene(scene, opts) {
    const { frame, extent } = await captureScene(scene, opts.model);

    const raster = cropRaster(frame, extent);
    const outWidth = opts.width;
    // Keep the shape of the visible area rather than forcing 4:3, so the
    // comparison is about the scaler and not about aspect correction.
    const outHeight = Math.round((outWidth * (extent.bottom - extent.top)) / (extent.right - extent.left));

    const { image: xbr, report } = xbrFrame(frame, extent, outWidth, outHeight, {
        eqThreshold: opts.eqThreshold,
        lv2Coefficient: opts.lv2Coefficient,
    });

    console.log(`\n${scene.name}: ${scene.description}`);
    console.log(`  visible raster ${raster.width}x${raster.height} at (${extent.left},${extent.top})`);
    for (const line of report) console.log(`  band ${line}`);

    const toImage = (raw) => {
        const image = makePixelImage(outWidth, outHeight);
        for (let i = 0; i < outWidth * outHeight; ++i)
            image.data[i] = (0xff << 24) | (raw[i * 3 + 2] << 16) | (raw[i * 3 + 1] << 8) | raw[i * 3];
        return image;
    };

    // What jsbeeb does today: the GPU stretches the raster onto the 896x600
    // canvas with GL_LINEAR, and the browser then scales that canvas to
    // whatever size the window is. Both steps resample, and the first one is
    // not an integer ratio, so it is the blurrier path of the two.
    // Note the intermediate must be materialised: chaining two `resize` calls
    // on one sharp pipeline keeps only the last.
    const onCanvas = await toRgbBuffer(raster)
        .resize(CanvasWidth, CanvasHeight, { kernel: "linear", fit: "fill" })
        .raw()
        .toBuffer();
    const today = toImage(
        await sharp(onCanvas, { raw: { width: CanvasWidth, height: CanvasHeight, channels: 3 } })
            .resize(outWidth, outHeight, { kernel: "linear", fit: "fill" })
            .raw()
            .toBuffer(),
    );
    const nearest = toImage(
        await toRgbBuffer(raster).resize(outWidth, outHeight, { kernel: "nearest", fit: "fill" }).raw().toBuffer(),
    );

    const variants = [
        { label: `bilinear (jsbeeb today, via ${CanvasWidth}x${CanvasHeight})`, image: today },
        { label: "nearest (raster, point sampled)", image: nearest },
        { label: "xBR-lv2 (logical pixels)", image: xbr },
    ];
    await writeComparison(variants, path.join(opts.out, `${scene.name}.png`), scene.name);
    if (scene.detail) {
        await writeDetail(variants, scene.detail, path.join(opts.out, `${scene.name}-detail.png`));
    }
}

async function main() {
    const parser = new ArgumentParser({ description: "Preview display upscaling options for jsbeeb" });
    parser.add_argument("--out", { default: "out/upscale-preview", help: "directory for the PNGs" });
    parser.add_argument("--scene", { help: "run only the named scene" });
    parser.add_argument("--model", { default: "B-DFS1.2" });
    parser.add_argument("--width", { type: "int", default: 1280, help: "output width in pixels" });
    parser.add_argument("--eq-threshold", { type: "float", default: undefined });
    parser.add_argument("--lv2-coefficient", { type: "float", default: undefined });
    const args = parser.parse_args();

    mkdirSync(args.out, { recursive: true });

    const scenes = args.scene ? Scenes.filter((s) => s.name === args.scene) : Scenes;
    if (scenes.length === 0) throw new Error(`No scene named "${args.scene}"`);
    for (const scene of scenes) {
        await runScene(scene, {
            out: args.out,
            model: args.model,
            width: args.width,
            eqThreshold: args.eq_threshold,
            lv2Coefficient: args.lv2_coefficient,
        });
    }
}

main().catch((error) => {
    console.error(`\nERROR: ${error.stack ?? error.message ?? error}`);
    process.exit(1);
});
