/**
 * What the corpus check and the in-memory check need from a title, whichever assembler its source is
 * for: its config's `source.assembler`, `baron` unless it says `beebasm`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import * as baron from "./baron-build.js";
import * as beebasm from "./beebasm-build.js";
import { importBaron, withTitle as withBaronTitle } from "./import-baron.js";
import { importBeebasm, withTitle as withBeebasmTitle } from "./import-beebasm.js";

export const BuildOptions = { ...baron.BuildOptions, ...beebasm.BuildOptions };
export const BuildUsage = "[--source <checkout>] [--baron <path>] [--beebasm <path>]";

const Assemblers = [baron.Baron, beebasm.Beebasm];

/** The assembler a config's source is for; refuses one no importer reads. */
export function assemblerOf(config) {
    const assembler = config.source.assembler ?? baron.Baron;
    if (!Assemblers.includes(assembler))
        throw new Error(
            `${config.id}'s source.assembler is ${assembler}, and the importers are ${Assemblers.join(" and ")}'s`,
        );
    return assembler;
}

/** The title's sets as its importer makes them, with the importer's errors. */
export function importTitle(configPath, options) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (assemblerOf(config) === beebasm.Beebasm)
        return withBeebasmTitle(configPath, options, ({ config, build, discFiles }) =>
            importBeebasm(config, build, { discFiles }),
        );
    return withBaronTitle(configPath, options, ({ config, build }) => importBaron(config, build));
}

/**
 * Runs `use` with the checkout of the config's commit and, for a baron title, the directory of its
 * built files (null for a beebasm one, whose SAVEs go where its source says).
 * @param {(made: {sourceDir: string, filesDir: string | null}) => any} use
 */
export function withTitleSource(config, options, use) {
    if (assemblerOf(config) === beebasm.Beebasm)
        return beebasm.withBeebasmBuild(config, options, ({ sourceDir }) => use({ sourceDir, filesDir: null }));
    return baron.withBaronBuild(config, options, ({ sourceDir, buildDir }) =>
        use({ sourceDir, filesDir: path.join(buildDir, baron.BuildLayout.files) }),
    );
}
