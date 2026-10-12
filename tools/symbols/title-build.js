/**
 * What the corpus check and the in-memory check need from a title, whichever assembler its source is
 * for: its config's `source.assembler`, `baron` unless it says `beebasm`; or, for a config that names
 * `py8dis`, the py8dis disassembly it is.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import * as baron from "./baron-build.js";
import * as beebasm from "./beebasm-build.js";
import { importBaron, withTitle as withBaronTitle } from "./import-baron.js";
import { importBeebasm, withTitle as withBeebasmTitle } from "./import-beebasm.js";
import { importPy8dis, Py8disOptions, Py8disUsage, withPy8disTitle } from "./import-py8dis.js";

export const BuildOptions = { ...baron.BuildOptions, ...beebasm.BuildOptions, ...Py8disOptions };
export const BuildUsage = `[--baron <path>] [--beebasm <path>] ${Py8disUsage}`;

const Assemblers = [baron.Baron, beebasm.Beebasm];
const Py8dis = "py8dis";

/**
 * The assembler a config's source is for; refuses one no importer reads, and a config for an importer
 * that has no build, such as acornaeology's.
 */
export function assemblerOf(config) {
    if (config.importer !== undefined)
        throw new Error(`${config.id} is for the ${config.importer} importer, which these checks don't take`);
    const assembler = config.source.assembler ?? baron.Baron;
    if (!Assemblers.includes(assembler))
        throw new Error(
            `${config.id}'s source.assembler is ${assembler}, and the importers are ${Assemblers.join(" and ")}'s`,
        );
    return assembler;
}

/** The importer for a config: py8dis's for one that names `py8dis`, else its assembler's. */
export const importerOf = (config) => (config.py8dis ? Py8dis : assemblerOf(config));

const Importers = {
    [Py8dis]: (configPath, options) =>
        withPy8disTitle(configPath, options, ({ config, dump, definitions }) =>
            importPy8dis(config, dump, definitions),
        ),
    [beebasm.Beebasm]: (configPath, options) =>
        withBeebasmTitle(configPath, options, ({ config, build, discFiles }) =>
            importBeebasm(config, build, { discFiles }),
        ),
    [baron.Baron]: (configPath, options) =>
        withBaronTitle(configPath, options, ({ config, build }) => importBaron(config, build)),
};

/** The title's sets as its importer makes them, with the importer's errors. */
export function importTitle(configPath, options) {
    return Importers[importerOf(JSON.parse(readFileSync(configPath, "utf8")))](configPath, options);
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
