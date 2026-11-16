// Keeps a VDFS volume in a folder of the host's: each file is a file, each directory a directory, and the load and
// exec addresses and the lock are in a `.inf` file beside it, as BeebAsm, Baron and b-em keep them. A `.` in a host
// name is a `/` to the 6502, which has no use for the dot in a name. See docs/vdfs.md.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { hexUpper } from "./hex.js";
import { LockedAttribute, isValidName } from "./vdfs-volume.js";

const InfSuffix = ".inf";
const LockedFlag = /^l(ocked)?$/i;
const AttributeToken = /^[0-9a-f]{1,2}$/i;

const toBbcName = (hostName) => hostName.replaceAll(".", "/");
const toHostName = (bbcName) => bbcName.replaceAll("/", ".");

/** @returns {{load: number, exec: number, locked: boolean}} what a `.inf` line says, with what it leaves out as 0. */
export function parseInf(text) {
    const [, load = "0", exec = "0", , ...rest] = text.trim().split(/\r?\n/)[0].split(/\s+/);
    const hexOrZero = (token) => (/^[0-9a-f]{1,8}$/i.test(token) ? parseInt(token, 16) >>> 0 : 0);
    const locked = rest.some(
        (token) =>
            LockedFlag.test(token) || (AttributeToken.test(token) && (parseInt(token, 16) & LockedAttribute) !== 0),
    );
    return { load: hexOrZero(load), exec: hexOrZero(exec), locked };
}

export function formatInf(name, { load, exec, locked, length }) {
    return `$.${name}  ${hexUpper(load, 8)} ${hexUpper(exec, 8)} ${hexUpper(length, 8)}${locked ? " L" : ""}\n`;
}

const isUnderRoot = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);

export class FsStore {
    /** @param {string} root the folder that is the volume's `$` */
    constructor(root) {
        this.root = path.resolve(root);
    }

    async load() {
        const items = [];
        const walk = async (hostDirectory, bbcPath) => {
            const dirents = await fs.readdir(hostDirectory, { withFileTypes: true });
            for (const dirent of dirents) {
                if (dirent.name.toLowerCase().endsWith(InfSuffix) || dirent.isSymbolicLink()) continue;
                const bbcName = toBbcName(dirent.name);
                if (!isValidName(bbcName)) continue;
                const hostPath = path.join(hostDirectory, dirent.name);
                const itemPath = [...bbcPath, bbcName];
                if (dirent.isDirectory()) {
                    items.push({ path: itemPath, isDirectory: true });
                    await walk(hostPath, itemPath);
                } else if (dirent.isFile()) {
                    const data = new Uint8Array(await fs.readFile(hostPath));
                    const inf = await this._readSidecar(hostPath + InfSuffix);
                    items.push({ path: itemPath, isDirectory: false, data, ...parseInf(inf) });
                }
            }
        };
        await walk(this.root, []);
        return items;
    }

    async _readSidecar(sidecarPath) {
        const stat = await fs.lstat(sidecarPath).catch(() => null);
        return stat?.isFile() ? fs.readFile(sidecarPath, "utf8") : "";
    }

    /** The host path for a volume path, which has to stay inside the root whatever the names in it say. */
    async _hostPath(volumePath) {
        const names = volumePath.map(toHostName);
        if (names.some((name) => name === "." || name === ".." || name.includes(path.sep)))
            throw new Error(`${volumePath.join(".")} is not a name that stays in the volume's folder`);
        const hostPath = path.join(this.root, ...names);
        const realRoot = await fs.realpath(this.root);
        const realParent = await fs.realpath(path.dirname(hostPath));
        if (!isUnderRoot(realRoot, realParent)) throw new Error(`${hostPath} is outside ${this.root}`);
        for (const candidate of [hostPath, hostPath + InfSuffix]) {
            const existing = await fs.lstat(candidate).catch(() => null);
            if (existing?.isSymbolicLink()) throw new Error(`${candidate} is a symbolic link`);
        }
        return hostPath;
    }

    /** On a host that tells `abc` from `ABC`, a file the BBC saves under the other case replaces the one there. */
    async _removeOtherCases(hostPath) {
        const directory = path.dirname(hostPath);
        const name = path.basename(hostPath);
        for (const other of await fs.readdir(directory)) {
            const isOtherCase = other !== name && other.toLowerCase() === name.toLowerCase();
            if (!isOtherCase) continue;
            await fs.rm(path.join(directory, other), { force: true });
            await fs.rm(path.join(directory, other + InfSuffix), { force: true });
        }
    }

    async writeFile(volumePath, { data, load, exec, locked }) {
        const hostPath = await this._hostPath(volumePath);
        await this._removeOtherCases(hostPath);
        await fs.writeFile(hostPath, data);
        const name = volumePath.at(-1);
        if (load !== 0 || exec !== 0 || locked) {
            await fs.writeFile(hostPath + InfSuffix, formatInf(name, { load, exec, locked, length: data.length }));
        } else {
            await fs.rm(hostPath + InfSuffix, { force: true });
        }
    }

    async makeDirectory(volumePath) {
        await fs.mkdir(await this._hostPath(volumePath), { recursive: true });
    }

    async remove(volumePath) {
        const hostPath = await this._hostPath(volumePath);
        const stat = await fs.lstat(hostPath);
        if (stat.isDirectory()) await fs.rmdir(hostPath);
        else {
            await fs.rm(hostPath);
            await fs.rm(hostPath + InfSuffix, { force: true });
        }
    }
}
