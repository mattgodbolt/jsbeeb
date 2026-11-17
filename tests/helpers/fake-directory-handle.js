const fail = (name, message) => new DOMException(message, name);

class FakeFile {
    constructor(name) {
        this.kind = "file";
        this.name = name;
        this.bytes = new Uint8Array(0);
    }

    async getFile() {
        const bytes = this.bytes;
        return {
            size: bytes.length,
            text: async () => new TextDecoder().decode(bytes),
            arrayBuffer: async () => bytes.slice().buffer,
        };
    }

    async createWritable() {
        let pending = this.bytes;
        return {
            write: async (data) => {
                pending = typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data);
            },
            close: async () => {
                this.bytes = pending;
            },
        };
    }
}

/** The part of a `FileSystemDirectoryHandle` that a folder store uses, in memory, telling `abc` from `ABC` as a disc does. */
export class FakeDirectory {
    constructor(name = "", permission = "granted") {
        this.kind = "directory";
        this.name = name;
        this.permission = permission;
        this.children = new Map();
    }

    async queryPermission() {
        return this.permission;
    }

    async requestPermission() {
        return this.permission;
    }

    async *values() {
        yield* this.children.values();
    }

    async getFileHandle(name, { create = false } = {}) {
        const existing = this.children.get(name);
        if (existing) {
            if (existing.kind !== "file") throw fail("TypeMismatchError", `${name} is a directory`);
            return existing;
        }
        if (!create) throw fail("NotFoundError", `${name} is not there`);
        const made = new FakeFile(name);
        this.children.set(name, made);
        return made;
    }

    async getDirectoryHandle(name, { create = false } = {}) {
        const existing = this.children.get(name);
        if (existing) {
            if (existing.kind !== "directory") throw fail("TypeMismatchError", `${name} is a file`);
            return existing;
        }
        if (!create) throw fail("NotFoundError", `${name} is not there`);
        const made = new FakeDirectory(name);
        this.children.set(name, made);
        return made;
    }

    async removeEntry(name) {
        const existing = this.children.get(name);
        if (!existing) throw fail("NotFoundError", `${name} is not there`);
        if (existing.kind === "directory" && existing.children.size > 0)
            throw fail("InvalidModificationError", `${name} is not empty`);
        this.children.delete(name);
    }

    /** Puts a file at a host path like "GAMES/ELITE", making the directories. */
    put(hostPath, content) {
        const names = hostPath.split("/");
        let directory = this;
        for (const name of names.slice(0, -1)) {
            if (!directory.children.has(name)) directory.children.set(name, new FakeDirectory(name));
            directory = directory.children.get(name);
        }
        const file = new FakeFile(names.at(-1));
        file.bytes = typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content);
        directory.children.set(file.name, file);
        return this;
    }

    /** The bytes of the file at a host path, as text, or undefined if there is none. */
    textAt(hostPath) {
        let node = this;
        for (const name of hostPath.split("/")) node = node?.children?.get(name);
        return node?.kind === "file" ? new TextDecoder().decode(node.bytes) : undefined;
    }

    namesIn(hostPath = "") {
        let node = this;
        for (const name of hostPath.split("/").filter(Boolean)) node = node.children.get(name);
        return [...node.children.keys()].sort();
    }
}
