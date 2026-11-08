#!/usr/bin/env node
// Renders every icon jsbeeb ships from the one vector owl, public/jsbeeb-icon.svg.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const RepoRoot = path.join(import.meta.dirname, "..");
const SourceSvg = readFileSync(path.join(RepoRoot, "public/jsbeeb-icon.svg"));
const SvgSize = 256;
const SvgDensity = 72;
const Background = SourceSvg.toString().match(/<rect [^>]*fill="([^"]+)"/)[1];
// Fractions of the icon's size; launchers may crop a maskable icon to any shape that holds this circle.
export const SafeZoneRadius = 0.4;
export const MaskableMargin = 0.09;
const MaskableScale = (SafeZoneRadius - MaskableMargin) / (await owlReach(await renderPng(SvgSize, 1)));

const PngIcons = [
    { file: "public/jsbeeb-icon.png", size: 256, scale: 1 },
    { file: "public/icons/apple-touch-icon.png", size: 180, scale: 1 },
    { file: "public/icons/icon-192.png", size: 192, scale: 1 },
    { file: "public/icons/icon-512.png", size: 512, scale: 1 },
    { file: "public/icons/maskable-512.png", size: 512, scale: MaskableScale },
];
const Favicon = { file: "public/favicon.ico", sizes: [16, 32, 48] };

async function renderPng(size, scale) {
    const owlSize = Math.round(size * scale);
    const border = (size - owlSize) / 2;
    return sharp(SourceSvg, { density: (SvgDensity * owlSize) / SvgSize })
        .extend({
            top: Math.floor(border),
            bottom: Math.ceil(border),
            left: Math.floor(border),
            right: Math.ceil(border),
            background: Background,
        })
        .png()
        .toBuffer();
}

/** How far the owl reaches from the image's centre, as a fraction of its size. The corner pixel is background. */
export async function owlReach(png) {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const centre = width / 2;
    let reach = 0;
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const pixel = (y * width + x) * channels;
            if (data.compare(data, 0, channels, pixel, pixel + channels) === 0) continue;
            reach = Math.max(reach, Math.hypot(x + 0.5 - centre, y + 0.5 - centre));
        }
    }
    return reach / width;
}

/** Every icon file, as the bytes to write under the repo root. */
export async function renderIcons() {
    const icons = await Promise.all(
        PngIcons.map(async ({ file, size, scale }) => ({ file, data: await renderPng(size, scale) })),
    );
    const faviconPngs = await Promise.all(Favicon.sizes.map((size) => renderPng(size, 1)));
    icons.push({ file: Favicon.file, data: await pngToIco(faviconPngs) });
    return icons;
}

if (import.meta.main) {
    for (const { file, data } of await renderIcons()) {
        const target = path.join(RepoRoot, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, data);
        console.log(`Wrote ${file}`);
    }
}
