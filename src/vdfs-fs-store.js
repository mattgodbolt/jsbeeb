// Keeps a VDFS volume in a folder of the host's: each file is a file, each directory a directory, and the load and
// exec addresses and the lock are in a `.inf` file beside it, as BeebAsm, Baron and b-em keep them. A `.` in a host
// name is a `/` to the 6502, which has no use for the dot in a name. The folder is read as it is asked about, never
// held. See docs/vdfs.md.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { InfSuffix, NoInformation, formatInf, parseInf, toBbcName, toHostName } from "./vdfs-inf.js";
import { isValidName, requireWritableName, sameName } from "./vdfs-names.js";

const isUnderRoot = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const isMissing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

export class FsStore {
    /** @param {string} root the folder that is the volume's `$` */
    constructor(root) {
        this.root = path.resolve(root);
    }

    /** Throws if there is no folder to serve. */
    async check() {
        if (!(await fs.stat(this.root)).isDirectory()) throw new Error(`${this.root} is not a folder`);
    }

    /** The host path for a volume path, which has to stay inside the root whatever the names in it say. */
    async _hostPath(volumePath, { newName = false } = {}) {
        if (volumePath.length === 0) return this.root;
        const given = volumePath.map(toHostName);
        if (given.some((name) => name === "." || name === ".." || name.includes(path.sep)))
            throw new Error(`${volumePath.join(".")} is not a name that stays in the volume's folder`);
        const hostPath = path.join(this.root, ...(await this._storedSpellings(volumePath, given, newName)));
        const realRoot = await fs.realpath(this.root);
        const realParent = await fs.realpath(path.dirname(hostPath));
        if (!isUnderRoot(realRoot, realParent)) throw new Error(`${hostPath} is outside ${this.root}`);
        for (const candidate of [hostPath, hostPath + InfSuffix]) {
            const existing = await fs.lstat(candidate).catch(() => null);
            if (existing?.isSymbolicLink()) throw new Error(`${candidate} is a symbolic link`);
        }
        return hostPath;
    }

    /**
     * The names a path has on the host, which may spell any of it in another case than the BBC did. A file about to be
     * written under `newName` keeps the spelling it is given.
     */
    async _storedSpellings(volumePath, given, newName) {
        const spelled = [];
        let directory = this.root;
        for (const [index, name] of (newName ? volumePath.slice(0, -1) : volumePath).entries()) {
            const entries = await fs.readdir(directory).catch((error) => {
                if (isMissing(error)) return [];
                throw error;
            });
            const stored = entries.includes(given[index])
                ? given[index]
                : entries.find((entry) => !entry.toLowerCase().endsWith(InfSuffix) && sameName(toBbcName(entry), name));
            spelled.push(stored ?? given[index]);
            directory = path.join(directory, stored ?? given[index]);
        }
        return newName ? [...spelled, given.at(-1)] : spelled;
    }

    async _readSidecar(sidecarPath) {
        const stat = await fs.lstat(sidecarPath).catch(() => null);
        return stat?.isFile() ? parseInf(await fs.readFile(sidecarPath, "utf8")) : NoInformation;
    }

    /** @returns {Promise<object | null>} what a directory entry is, or nothing if it went while it was looked at */
    async _describe(hostPath, dirent) {
        const name = toBbcName(dirent.name);
        if (dirent.isDirectory()) return { name, isDirectory: true, size: 0, ...NoInformation };
        try {
            const { size } = await fs.lstat(hostPath);
            return { name, isDirectory: false, size, ...(await this._readSidecar(hostPath + InfSuffix)) };
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
    }

    /** What is in the directory that a BBC could name, and the names of what is not. */
    async _entries(directory) {
        const entries = [];
        const skipped = [];
        let hostDirectory;
        let dirents;
        try {
            hostDirectory = await this._hostPath(directory);
            dirents = await fs.readdir(hostDirectory, { withFileTypes: true });
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
        for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
            if (dirent.name.toLowerCase().endsWith(InfSuffix) || dirent.isSymbolicLink()) continue;
            if (!dirent.isDirectory() && !dirent.isFile()) continue;
            if (!isValidName(toBbcName(dirent.name))) skipped.push(dirent.name);
            else entries.push({ dirent, hostPath: path.join(hostDirectory, dirent.name) });
        }
        return { entries, skipped };
    }

    /** @returns {Promise<{name: string, isDirectory: boolean, size: number, load: number, exec: number, locked: boolean} | null>} */
    async find(directory, name) {
        const found = await this._entries(directory);
        const match = found?.entries.find(({ dirent }) => sameName(toBbcName(dirent.name), name));
        return match ? this._describe(match.hostPath, match.dirent) : null;
    }

    /** @returns {Promise<{entries: object[], skipped: string[]} | null>} what is in a directory, null if there is none */
    async list(directory) {
        const found = await this._entries(directory);
        if (!found) return null;
        const described = await Promise.all(
            found.entries.map(({ dirent, hostPath }) => this._describe(hostPath, dirent)),
        );
        return { entries: described.filter(Boolean), skipped: found.skipped };
    }

    async read(volumePath) {
        const hostPath = await this._hostPath(volumePath);
        return new Uint8Array(await fs.readFile(hostPath));
    }

    /** On a host that tells `abc` from `ABC`, a file the BBC saves under the other case replaces the one there. */
    async _removeOtherCases(hostPath) {
        const directory = path.dirname(hostPath);
        const name = path.basename(hostPath);
        const others = (await fs.readdir(directory, { withFileTypes: true })).filter(
            (other) => other.name !== name && other.name.toLowerCase() === name.toLowerCase(),
        );
        const directoryAmongThem = others.find((other) => other.isDirectory());
        if (directoryAmongThem) throw new Error(`${directoryAmongThem.name} is a directory`);
        for (const other of others) {
            await fs.rm(path.join(directory, other.name), { force: true });
            await fs.rm(path.join(directory, other.name + InfSuffix), { force: true });
        }
    }

    async _writeInformation(hostPath, name, { load, exec, locked }, length) {
        if (load !== 0 || exec !== 0 || locked) {
            await fs.writeFile(hostPath + InfSuffix, formatInf(name, { load, exec, locked, length }));
        } else {
            await fs.rm(hostPath + InfSuffix, { force: true });
        }
    }

    async writeFile(volumePath, { data, load, exec, locked }) {
        requireWritableName(volumePath);
        const hostPath = await this._hostPath(volumePath, { newName: true });
        await this._removeOtherCases(hostPath);
        await fs.writeFile(hostPath, data);
        await this._writeInformation(hostPath, volumePath.at(-1), { load, exec, locked }, data.length);
    }

    /** Changes a file's addresses or lock, as many of them as are given, and leaves what it holds. */
    async setInfo(volumePath, changes) {
        requireWritableName(volumePath);
        const hostPath = await this._hostPath(volumePath);
        const found = await fs.lstat(hostPath).catch((error) => {
            throw isMissing(error) ? new Error(`${volumePath.join(".")} is not there`) : error;
        });
        if (!found.isFile()) throw new Error(`${volumePath.join(".")} is not a file`);
        const { size } = found;
        const current = await this._readSidecar(hostPath + InfSuffix);
        await this._writeInformation(hostPath, volumePath.at(-1), { ...current, ...changes }, size);
    }

    async makeDirectory(volumePath) {
        requireWritableName(volumePath);
        await fs.mkdir(await this._hostPath(volumePath), { recursive: true });
    }

    async remove(volumePath) {
        requireWritableName(volumePath);
        const hostPath = await this._hostPath(volumePath);
        const stat = await fs.lstat(hostPath);
        if (stat.isDirectory()) await fs.rmdir(hostPath);
        else {
            await fs.rm(hostPath);
            await fs.rm(hostPath + InfSuffix, { force: true });
        }
    }
}
