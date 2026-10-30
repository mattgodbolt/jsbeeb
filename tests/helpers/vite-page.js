import { readFileSync } from "node:fs";
import { createServer } from "vite";

/** `html` as a dev server with only `plugin` serves it at /index.html. */
export async function htmlThroughPlugin(plugin, html) {
    const server = await createServer({
        configFile: false,
        logLevel: "silent",
        plugins: [plugin],
        server: { middlewareMode: true, hmr: false, ws: false },
    });
    try {
        return await server.transformIndexHtml("/index.html", html);
    } finally {
        await server.close();
    }
}

/** The repository's index.html, partials not stitched in, as a dev server with only `plugin` serves it. */
export const indexHtmlThroughPlugin = (plugin) =>
    htmlThroughPlugin(plugin, readFileSync(new URL("../../index.html", import.meta.url), "utf8"));
