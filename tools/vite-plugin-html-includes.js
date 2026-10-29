import { relative } from "node:path";
import { repoPath, stitchIncludes } from "./html-includes.js";

const PartialsDir = repoPath("html");

const isPartial = (file) => !relative(PartialsDir, file).startsWith("..");

/** Expands index.html's `<!-- include: ... -->` lines, and reloads the dev page when a partial changes. */
export function htmlIncludesPlugin() {
    return {
        name: "html-includes",
        transformIndexHtml: {
            order: "pre",
            handler: (html, { filename }) => stitchIncludes(html, relative(repoPath("."), filename)),
        },
        // Vite's own reload for a changed .html names that file's path, which only a page at that path obeys.
        hotUpdate({ file }) {
            if (this.environment.name !== "client" || !isPartial(file)) return;
            this.environment.hot.send({ type: "full-reload" });
        },
    };
}
