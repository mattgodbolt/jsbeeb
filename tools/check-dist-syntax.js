#!/usr/bin/env node
/**
 * Fails if any script in the built site uses syntax newer than the oldest
 * browser in package.json's browserslist can parse. Vite lowers syntax to that
 * target, but nothing else checks what dependencies and the minifier emit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

// The newest edition every browserslist entry parses in full; ES2024's regexp v flag is past all of them.
const FloorEcmaVersion = 2023;
const DistDir = "dist";

export function syntaxError(source, sourceType) {
    try {
        parse(source, { ecmaVersion: FloorEcmaVersion, sourceType });
        return null;
    } catch (error) {
        return error.message;
    }
}

export function inlineScripts(html) {
    const scripts = [];
    for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        if (/\bsrc=/.test(attributes)) continue;
        scripts.push({ source: body, sourceType: /\btype=["']?module\b/.test(attributes) ? "module" : "script" });
    }
    return scripts;
}

function main() {
    const scripts = fs
        .readdirSync(DistDir, { recursive: true })
        .filter((file) => file.endsWith(".js"))
        .map((file) => ({
            name: file,
            source: fs.readFileSync(path.join(DistDir, file), "utf8"),
            sourceType: "module",
        }));
    const html = fs.readFileSync(path.join(DistDir, "index.html"), "utf8");
    inlineScripts(html).forEach((script, index) => scripts.push({ name: `index.html script ${index + 1}`, ...script }));

    let failures = 0;
    for (const { name, source, sourceType } of scripts) {
        const error = syntaxError(source, sourceType);
        if (error === null) continue;
        console.error(`${name} does not parse as ES${FloorEcmaVersion}: ${error}`);
        failures++;
    }
    if (failures === 0) console.log(`${scripts.length} scripts in ${DistDir} parse as ES${FloorEcmaVersion}`);
    return failures === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main());
}
