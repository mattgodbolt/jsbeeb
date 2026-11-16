#!/usr/bin/env node
/**
 * Assembles the VDFS ROM (roms-src/vdfs) with Baron and puts it at public/roms/vdfs.rom, or with --check says whether
 * the ROM that is there is what the source gives. Baron is `$BARON` or `baron` on the PATH; the version the checks
 * use is pinned in .github/workflows/vdfs-rom.yml.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SourceDir = "roms-src/vdfs";
const RomName = "vdfs.rom";
const Installed = path.join("public", "roms", RomName);

/** @returns {Buffer} the ROM Baron assembles from the source. */
export function assemble(baron = process.env.BARON ?? "baron") {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "vdfs-rom-"));
    try {
        const output = execFileSync(baron, ["--warn", "2", "-p", out, "vdfs.6502"], {
            cwd: SourceDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (output.includes("warning:")) throw new Error(`Baron warned:\n${output}`);
        return fs.readFileSync(path.join(out, RomName));
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
}

function main(args) {
    const built = assemble();
    if (args.includes("--check")) {
        if (!built.equals(fs.readFileSync(Installed))) {
            console.error(`${Installed} is not what ${SourceDir} assembles to: run npm run build:vdfs-rom`);
            return 1;
        }
        console.log(`${Installed} matches ${SourceDir}`);
        return 0;
    }
    fs.writeFileSync(Installed, built);
    console.log(`Wrote ${Installed} (${built.length} bytes)`);
    return 0;
}

if (import.meta.main) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (error) {
        console.error(error.stderr?.toString() || error.message);
        process.exit(1);
    }
}
