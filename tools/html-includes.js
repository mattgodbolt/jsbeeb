import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RepoRoot = resolve(import.meta.dirname, "..");
const IncludeLine = /^[ \t]*<!-- include: (\S+) -->[ \t]*$/gm;

/** The repo-relative path `file` as an absolute one. */
export const repoPath = (file) => resolve(RepoRoot, file);

function readPartial(file, includedFrom) {
    try {
        return readFileSync(repoPath(file), "utf8");
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
        throw new Error(`${includedFrom} includes ${file}, which does not exist`, { cause: err });
    }
}

function expandIncludes(html, chain) {
    return html.replace(IncludeLine, (_line, file) => {
        if (chain.includes(file)) throw new Error(`HTML include cycle: ${[...chain, file].join(" -> ")}`);
        return expandIncludes(readPartial(file, chain.at(-1)).trimEnd(), [...chain, file]);
    });
}

/**
 * `html`, which is the content of `file`, with each `<!-- include: path -->` line replaced by that file, its own
 * includes expanded too. Paths are relative to the repo root.
 */
export const stitchIncludes = (html, file) => expandIncludes(html, [file]);

/** The repo-relative `file` with its includes expanded, as the build serves it. */
export const stitchHtml = (file) => stitchIncludes(readFileSync(repoPath(file), "utf8"), file);
