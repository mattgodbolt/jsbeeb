// The tree of files the VDFS host serves: held in memory, since the 6502 cannot wait for a host's storage, with
// changes handed to a store to persist afterwards. See docs/vdfs.md.

export const MaxNameLength = 10;
const PrintableAscii = /^[!-~]*$/;
const NameSeparators = /[.:"*#|]/;
const SpecialDirectories = new Set(["$", "&", "@", "%", "^"]);

/** An error the host raises on the 6502 as the OS would: BRK, the number, then the text. */
export class VdfsError extends Error {
    constructor(number, text) {
        super(text);
        this.number = number;
    }
}

export const Errors = Object.freeze({
    badName: () => new VdfsError(0xcc, "Bad name"),
    notFound: () => new VdfsError(0xd6, "Not found"),
    locked: () => new VdfsError(0xc3, "Locked"),
    exists: () => new VdfsError(0xc4, "Already exists"),
    notEmpty: () => new VdfsError(0xb4, "Dir not empty"),
    isDirectory: () => new VdfsError(0xc7, "Is a directory"),
    notDirectory: () => new VdfsError(0xbe, "Not a directory"),
    tooManyOpen: () => new VdfsError(0xc0, "Too many open files"),
    notOpen: () => new VdfsError(0xde, "Channel"),
    accessViolation: () => new VdfsError(0xbd, "Access violation"),
    fileTooBig: () => new VdfsError(0xc6, "File too big"),
    noAddresses: () => new VdfsError(0xcd, "No load address"),
    badCommand: () => new VdfsError(0xfe, "Bad command"),
    badAddress: () => new VdfsError(0x93, "Bad address"),
    unsupported: (what) => new VdfsError(0x94, `${what} is not supported`),
    eof: () => new VdfsError(0xdf, "EOF"),
});

/** A name that ends in `/inf` would be a host file that ends in `.inf`, which is where a file's addresses are kept. */
const SidecarName = /\/inf$/i;

export function isValidName(name) {
    return (
        name.length > 0 &&
        name.length <= MaxNameLength &&
        PrintableAscii.test(name) &&
        !NameSeparators.test(name) &&
        !SidecarName.test(name) &&
        !SpecialDirectories.has(name)
    );
}

const keyOf = (name) => name.toUpperCase();

/** @returns {RegExp} what a `*` and `#` pattern matches, whatever the case. */
export function wildcardMatcher(pattern) {
    const source = [...pattern]
        .map((char) => (char === "*" ? ".*" : char === "#" ? "." : char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")))
        .join("");
    return new RegExp(`^${source}$`, "i");
}

/** A file or a directory in the tree. A file's bytes grow by doubling, since a file is written a byte at a time. */
export class Entry {
    constructor(name, { isDirectory = false, load = 0, exec = 0, locked = false, data } = {}) {
        this.name = name;
        this.isDirectory = isDirectory;
        this.load = load >>> 0;
        this.exec = exec >>> 0;
        this.locked = locked;
        /** @type {Entry | null} */
        this.parent = null;
        /** Whether it has been taken out of the tree, so that what is written to it is not the volume's any more. */
        this.detached = false;
        if (isDirectory) {
            /** @type {Map<string, Entry>} */
            this.children = new Map();
        } else {
            this.buffer = data ?? new Uint8Array(0);
            this.length = this.buffer.length;
        }
    }

    get bytes() {
        return this.buffer.subarray(0, this.length);
    }

    /** Sets the length, zero-filling any growth. */
    resize(length) {
        if (length > this.buffer.length) {
            const bigger = new Uint8Array(Math.max(length, this.buffer.length * 2));
            bigger.set(this.bytes);
            this.buffer = bigger;
        } else if (length < this.length) {
            this.buffer.fill(0, length, this.length);
        }
        this.length = length;
    }

    /** @returns {string[]} the names from the root down, the root itself not among them. */
    get path() {
        const names = [];
        for (let entry = this; entry.parent; entry = entry.parent) names.unshift(entry.name);
        return names;
    }

    /** @returns {Entry[]} a directory's entries in name order. */
    listing() {
        return [...this.children.values()].sort((a, b) => keyOf(a.name).localeCompare(keyOf(b.name)));
    }

    get displayPath() {
        return ["$", ...this.path].join(".");
    }
}

/**
 * The tree, and the way into it from a name as the 6502 gives it. Changes are passed to the store in order, one at
 * a time, and the tree does not wait for them: `flush()` is the way to know they are done.
 */
export class VdfsVolume {
    /**
     * @param {object | null} store what persists changes: `writeFile(path, {data, load, exec, locked})`,
     *   `makeDirectory(path)` and `remove(path)`, each returning a promise, and `load()` for `VdfsVolume.open`
     */
    constructor(store = null) {
        this.store = store;
        this.root = new Entry("$", { isDirectory: true });
        this._pending = Promise.resolve();
        /** @type {{operation: string, error: Error}[]} */
        this.persistFailures = [];
        /** @type {((operation: string, error: Error) => void) | null} called when the store fails a change */
        this.onPersistFailure = null;
    }

    static async open(store) {
        const volume = new VdfsVolume(store);
        await volume.load();
        return volume;
    }

    /** Fills the tree from the store, which is done once, before the machine is started. */
    async load() {
        this.populate(await this.store.load());
    }

    /** Builds the tree from what a store's `load()` returns: `{path, isDirectory, load, exec, locked, data}`. */
    populate(items) {
        for (const { path, isDirectory, ...rest } of items) {
            let dir = this.root;
            for (const name of path.slice(0, -1)) dir = this._childDirectory(dir, name);
            const name = path.at(-1);
            if (isDirectory) this._childDirectory(dir, name);
            else this._add(dir, new Entry(name, rest));
        }
    }

    _childDirectory(dir, name) {
        const existing = dir.children.get(keyOf(name));
        if (existing) return existing;
        return this._add(dir, new Entry(name, { isDirectory: true }));
    }

    _add(dir, entry) {
        const replaced = dir.children.get(keyOf(entry.name));
        if (replaced) replaced.detached = true;
        entry.parent = dir;
        dir.children.set(keyOf(entry.name), entry);
        return entry;
    }

    /**
     * Follows a name as the 6502 spells it: an optional `:0.` drive, then dot-separated parts, the first of which may
     * be `$` or `&` (the root), `@` (the current directory), `%` (the library) or `^` (the parent).
     *
     * @param {string} text
     * @param {{cwd: Entry, library: Entry}} where
     * @returns {{parent: Entry, name: string, entry: Entry | undefined}} the directory the last part is in, the
     *   last part, and what it names. A name that is only a directory is that directory, in its own parent.
     */
    resolve(text, { cwd, library }) {
        const withoutDrive = text.replace(/^:[^.]*\.?/, "");
        const parts = withoutDrive.length === 0 ? ["@"] : withoutDrive.split(".");
        if (!parts.every((part) => SpecialDirectories.has(part) || isValidName(part))) throw Errors.badName();
        let dir = cwd;
        let index = 0;
        const first = parts[0];
        if (first === "$" || first === "&") {
            dir = this.root;
            index = 1;
        } else if (first === "%") {
            dir = library;
            index = 1;
        }
        if (index === parts.length) return { parent: dir.parent ?? dir, name: dir.name, entry: dir };
        for (; index < parts.length - 1; index++) dir = this._step(dir, parts[index]);
        const last = parts[index];
        if (last === "^" || last === "@") {
            const target = this._step(dir, last);
            return { parent: target.parent ?? target, name: target.name, entry: target };
        }
        if (!isValidName(last)) throw Errors.badName();
        return { parent: dir, name: last, entry: dir.children.get(keyOf(last)) };
    }

    _step(dir, part) {
        if (part === "^") return dir.parent ?? dir;
        if (part === "@") return dir;
        if (SpecialDirectories.has(part) || !isValidName(part)) throw Errors.badName();
        const child = dir.children.get(keyOf(part));
        if (!child) throw Errors.notFound();
        if (!child.isDirectory) throw Errors.notDirectory();
        return child;
    }

    /** Makes or replaces a file, which is persisted when `persist` is called for it. */
    createFile(parent, name, { load = 0, exec = 0, data } = {}) {
        const existing = parent.children.get(keyOf(name));
        if (existing?.isDirectory) throw Errors.isDirectory();
        if (existing?.locked) throw Errors.locked();
        const entry = new Entry(name, { load, exec, data: data ?? new Uint8Array(0) });
        return this._add(parent, entry);
    }

    makeDirectory(parent, name) {
        const entry = this._add(parent, new Entry(name, { isDirectory: true }));
        this._enqueue("makeDirectory", () => this.store?.makeDirectory(entry.path));
        return entry;
    }

    /** Writes a file's bytes and details to the store. */
    persist(entry) {
        if (entry.detached) return;
        const path = entry.path;
        const details = { data: entry.bytes.slice(), load: entry.load, exec: entry.exec, locked: entry.locked };
        this._enqueue("writeFile", () => this.store?.writeFile(path, details));
    }

    remove(entry) {
        if (!entry.parent) throw Errors.accessViolation();
        if (entry.isDirectory && entry.children.size > 0) throw Errors.notEmpty();
        if (entry.locked) throw Errors.locked();
        const path = entry.path;
        entry.parent.children.delete(keyOf(entry.name));
        entry.detached = true;
        this._enqueue("remove", () => this.store?.remove(path));
    }

    _enqueue(operation, run) {
        this._pending = this._pending.then(run).catch((error) => {
            this.persistFailures.push({ operation, error });
            console.error(`VDFS could not persist ${operation}:`, error);
            try {
                this.onPersistFailure?.(operation, error);
            } catch (listenerError) {
                console.error("VDFS persist failure listener failed:", listenerError);
            }
        });
    }

    /** @returns {Promise<void>} once every change made so far has reached the store. */
    flush() {
        return this._pending;
    }
}
