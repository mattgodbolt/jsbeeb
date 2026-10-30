import { describe, expect, it, vi } from "vitest";

import { repoPath } from "../../../tools/html-includes.js";
import { htmlIncludesPlugin } from "../../../tools/vite-plugin-html-includes.js";
import { htmlThroughPlugin } from "../../helpers/vite-page.js";

describe("htmlIncludesPlugin", () => {
    it("expands includes in the page it serves", async () => {
        const html = await htmlThroughPlugin(htmlIncludesPlugin(), "<!-- include: html/help.html -->\n");
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
