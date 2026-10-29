import { createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { repoPath } from "../../../tools/html-includes.js";
import { htmlIncludesPlugin } from "../../../tools/vite-plugin-html-includes.js";

describe("htmlIncludesPlugin", () => {
    let server;

    afterEach(async () => {
        await server?.close();
    });

    it("serves index.html with its includes expanded", async () => {
        server = await createServer({
            configFile: false,
            logLevel: "silent",
            plugins: [htmlIncludesPlugin()],
            server: { middlewareMode: true, hmr: false, ws: false },
        });
        const html = await server.transformIndexHtml("/index.html", "<!-- include: html/help.html -->\n");
        expect(html).toContain('id="help"');
    });

    describe("when a file changes", () => {
        const hotUpdate = (environmentName, file) => {
            const send = vi.fn();
            htmlIncludesPlugin().hotUpdate.call({ environment: { name: environmentName, hot: { send } } }, { file });
            return send;
        };

        it("reloads the page for a partial", () => {
            expect(hotUpdate("client", repoPath("html/help.html"))).toHaveBeenCalledWith({ type: "full-reload" });
        });

        it("leaves other files to Vite", () => {
            expect(hotUpdate("client", repoPath("src/main.js"))).not.toHaveBeenCalled();
        });

        it("reloads only the client", () => {
            expect(hotUpdate("ssr", repoPath("html/help.html"))).not.toHaveBeenCalled();
        });
    });
});
