// A VDFS volume in a folder the user gave the page through the File System Access API: the same store as
// `FsStore`, over a `FileSystemDirectoryHandle`. See docs/vdfs.md.

import { InfSuffix, NoInformation, formatInf, parseInf, toBbcName, toHostName } from "../vdfs-inf.js";
import { isValidName, requireWritableName, sameName } from "../vdfs-names.js";

const Mode = { mode: "readwrite" };
const isMissing = (error) => error?.name === "NotFoundError" || error?.name === "TypeMismatchError";

export class FolderStore {
    /** @param {() => Promise<FileSystemDirectoryHandle | null>} loadRoot gives the folder that is the volume's `$` */
    constructor(loadRoot) {
        this._loadRoot = loadRoot;
        this._rootPromise = null;
    }

    _loadedRoot() {
        this._rootPromise ??= this._loadRoot();
        return this._rootPromise;
    }

    /** @returns {Promise<"none" | "granted" | "prompt" | "denied">} whether there is a folder, and may be used */
    async permission() {
        const root = await this._loadedRoot();
        return root ? root.queryPermission(Mode) : "none";
    }

    /** Asks the user, which the browser only allows from a click. */
    async requestPermission() {
        const root = await this._loadedRoot();
        return root ? root.requestPermission(Mode) : "none";
    }

    async _root() {
        const state = await this.permission();
        if (state === "none") throw new Error("No folder has been chosen to serve as VDFS");
        if (state === "denied")
            throw new Error("The browser will not let the page use the VDFS folder; allow it in the site settings");
        if (state !== "granted") throw new Error("The browser has not been told that the VDFS folder may be used");
        return this._loadedRoot();
    }

    async _entries(handle) {
        const entries = [];
        for await (const entry of handle.values()) entries.push(entry);
        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The directory handle for a volume path, or null if there is none such. */
    async _directory(volumePath) {
        let handle = await this._root();
        for (const name of volumePath) {
            const match = (await this._entries(handle)).find(
                (entry) => entry.kind === "directory" && sameName(toBbcName(entry.name), name),
            );
            if (!match) return null;
            handle = match;
        }
        return handle;
    }

    async _entry(volumePath, kind) {
        const parent = await this._directory(volumePath.slice(0, -1));
        if (!parent) return { parent, entry: undefined };
        const name = volumePath.at(-1);
        const entry = (await this._entries(parent)).find(
            (candidate) => (!kind || candidate.kind === kind) && sameName(toBbcName(candidate.name), name),
        );
        return { parent, entry };
    }

    async _readSidecar(parent, hostName) {
        try {
            const file = await (await parent.getFileHandle(hostName + InfSuffix)).getFile();
            return parseInf(await file.text());
        } catch (error) {
            if (isMissing(error)) return NoInformation;
            throw error;
        }
    }

    async _describe(parent, entry) {
        const name = toBbcName(entry.name);
        if (entry.kind === "directory") return { name, isDirectory: true, size: 0, ...NoInformation };
        try {
            const { size } = await entry.getFile();
            return { name, isDirectory: false, size, ...(await this._readSidecar(parent, entry.name)) };
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
    }

    /** What is in the directory that a BBC could name, and the names of what is not. */
    async _named(handle) {
        const entries = [];
        const skipped = [];
        for (const entry of await this._entries(handle)) {
            if (entry.name.toLowerCase().endsWith(InfSuffix)) continue;
            if (isValidName(toBbcName(entry.name))) entries.push(entry);
            else skipped.push(entry.name);
        }
        return { entries, skipped };
    }

    async find(directory, name) {
        const parent = await this._directory(directory);
        if (!parent) return null;
        const { entries } = await this._named(parent);
        const match = entries.find((entry) => sameName(toBbcName(entry.name), name));
        return match ? this._describe(parent, match) : null;
    }

    async list(directory) {
        const parent = await this._directory(directory);
        if (!parent) return null;
        const { entries, skipped } = await this._named(parent);
        const described = await Promise.all(entries.map((entry) => this._describe(parent, entry)));
        return { entries: described.filter(Boolean), skipped };
    }

    async read(volumePath) {
        const { entry } = await this._entry(volumePath, "file");
        if (!entry) throw new Error(`${volumePath.join(".")} is not there`);
        return new Uint8Array(await (await entry.getFile()).arrayBuffer());
    }

    async _writeBytes(parent, hostName, data) {
        const writable = await (await parent.getFileHandle(hostName, { create: true })).createWritable();
        try {
            await writable.write(data);
            await writable.close();
        } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
        }
    }

    async _removeIfThere(parent, hostName) {
        try {
            await parent.removeEntry(hostName);
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
    }

    async _writeInformation(parent, hostName, name, { load, exec, locked }, length) {
        if (load !== 0 || exec !== 0 || locked)
            await this._writeBytes(parent, hostName + InfSuffix, formatInf(name, { load, exec, locked, length }));
        else await this._removeIfThere(parent, hostName + InfSuffix);
    }

    async writeFile(volumePath, { data, load, exec, locked }) {
        requireWritableName(volumePath);
        const parent = await this._directory(volumePath.slice(0, -1));
        if (!parent) throw new Error(`${volumePath.slice(0, -1).join(".")} is not there`);
        const hostName = toHostName(volumePath.at(-1));
        for (const other of await this._entries(parent)) {
            const isOtherCase = other.name !== hostName && other.name.toLowerCase() === hostName.toLowerCase();
            if (other.kind !== "file" || !isOtherCase) continue;
            await this._removeIfThere(parent, other.name);
            await this._removeIfThere(parent, other.name + InfSuffix);
        }
        await this._writeBytes(parent, hostName, data);
        await this._writeInformation(parent, hostName, volumePath.at(-1), { load, exec, locked }, data.length);
    }

    async setInfo(volumePath, changes) {
        requireWritableName(volumePath);
        const { parent, entry } = await this._entry(volumePath, "file");
        if (!entry) throw new Error(`${volumePath.join(".")} is not there`);
        const { size } = await entry.getFile();
        const current = await this._readSidecar(parent, entry.name);
        await this._writeInformation(parent, entry.name, volumePath.at(-1), { ...current, ...changes }, size);
    }

    async makeDirectory(volumePath) {
        requireWritableName(volumePath);
        let handle = await this._root();
        for (const name of volumePath) {
            const existing = (await this._entries(handle)).find(
                (entry) => entry.kind === "directory" && sameName(toBbcName(entry.name), name),
            );
            handle = existing ?? (await handle.getDirectoryHandle(toHostName(name), { create: true }));
        }
    }

    async remove(volumePath) {
        requireWritableName(volumePath);
        const { parent, entry } = await this._entry(volumePath);
        if (!entry) throw new Error(`${volumePath.join(".")} is not there`);
        await parent.removeEntry(entry.name);
        if (entry.kind === "file") await this._removeIfThere(parent, entry.name + InfSuffix);
    }
}
