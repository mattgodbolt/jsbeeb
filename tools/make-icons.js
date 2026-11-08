#!/usr/bin/env node
// Renders every icon jsbeeb ships from the one vector owl, public/jsbeeb-icon.svg.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const RepoRoot = path.join(import.meta.dirname, "..");
const SourceSvg = "public/jsbeeb-icon.svg";
const SvgSize = 256;
const SvgDensity = 72;
const Background = "#240202";
// The farthest dot reaches 146 of the SVG's 256 units from the centre, and a maskable icon's safe zone is a circle
// of radius 40% of the icon.
const MaskableScale = 0.7;

const PngIcons = [
    { file: "public/jsbeeb-icon.png", size: 256, scale: 1 },
    { file: "public/icons/apple-touch-icon.png", size: 180, scale: 1 },
    { file: "public/icons/icon-192.png", size: 192, scale: 1 },
    { file: "public/icons/icon-512.png", size: 512, scale: 1 },
    { file: "public/icons/maskable-512.png", size: 512, scale: MaskableScale },
];
export const Favicon = { file: "public/favicon.ico", sizes: [16, 32, 48] };

async function renderPng(size, scale) {
    const owlSize = Math.round(size * scale);
    const border = (size - owlSize) / 2;
    return sharp(readFileSync(path.join(RepoRoot, SourceSvg)), { density: (SvgDensity * owlSize) / SvgSize })
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

/** Every icon file, as the bytes to write under the repo root. */
export async function renderIcons() {
    const icons = await Promise.all(
        PngIcons.map(async ({ file, size, scale }) => ({ file, data: await renderPng(size, scale) })),
    );
    const faviconPngs = await Promise.all(Favicon.sizes.map((size) => renderPng(size, 1)));
    icons.push({ file: Favicon.file, data: await pngToIco(faviconPngs) });
    return icons;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    for (const { file, data } of await renderIcons()) {
        const target = path.join(RepoRoot, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, data);
        console.log(`Wrote ${file}`);
    }
}
