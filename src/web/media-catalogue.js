import { describe as describeHfe } from "../bbcdiscs.js";

/**
 * One shape for everything the media window can list, whichever source it
 * came from:
 *
 *   { ref, kind, title, publisher, detail, source, tracks, sides, savesChanges }
 *
 * `ref` is what loadDiscImage or loadTapeImage takes and what goes in the URL.
 */

export const Sources = Object.freeze({
    builtin: { name: "Built in", title: "The example discs that ship with jsbeeb" },
    sth: { name: "STH archive", title: "The Stairway To Hell mirror" },
    hfe: { name: "HFE archive", title: "Flux-level disc images, with title, publisher and side" },
    gdrive: { name: "Google Drive", title: "Your Google Drive; changes are kept there" },
    browser: { name: "This browser", title: "Discs kept in this browser's storage; changes are kept" },
    session: { name: "This session", title: "Files opened this session; they cannot be named in the URL" },
});

const LocalDiscPrefix = "disc_";

const describeSth = (path, kind) => {
    const slash = path.lastIndexOf("/");
    const file = path.slice(slash + 1).replace(/\.zip$/i, "");
    return {
        ref: `sth:${path}`,
        kind,
        title: file,
        publisher: slash >= 0 ? path.slice(0, slash) : "",
        detail: "",
        source: "sth",
        savesChanges: false,
    };
};

export const describeSthDisc = (path) => describeSth(path, "disc");
export const describeSthTape = (path) => describeSth(path, "tape");

const sidesOf = (file) => (file.disc?.includes("DS") ? 2 : 1);

export function describeHfeEntry(file) {
    const { title, publisher, detail } = describeHfe(file);
    return {
        ref: `hfe:${file.path}`,
        kind: "disc",
        title,
        publisher,
        detail,
        source: "hfe",
        tracks: file.tracks?.[0],
        sides: file.disc ? sidesOf(file) : undefined,
        provenance: file.provenance,
        savesChanges: false,
    };
}

export const describeBuiltIn = (image) => ({
    ref: image.file,
    kind: "disc",
    title: image.name,
    publisher: "",
    detail: image.desc,
    source: "builtin",
    savesChanges: false,
});

export const describeDriveFile = (file) => ({
    ref: `gd:${file.id}/${file.name}`,
    kind: "disc",
    title: file.name,
    publisher: "",
    detail: "",
    source: "gdrive",
    savesChanges: file.capabilities?.canEdit !== false,
});

export const describeBrowserDisc = (name) => ({
    ref: `local:${name}`,
    kind: "disc",
    title: name,
    publisher: "",
    detail: "",
    source: "browser",
    savesChanges: true,
});

export const describeSessionFile = (name, kind) => ({
    ref: `session:${name}`,
    kind,
    title: name,
    publisher: "",
    detail: "opened this session",
    source: "session",
    savesChanges: false,
});

/** The discs held in the browser's storage, by name. */
export function browserDiscNames(storage = window.localStorage) {
    const names = [];
    for (let i = 0; i < storage.length; ++i) {
        const key = storage.key(i);
        if (key.startsWith(LocalDiscPrefix)) names.push(key.slice(LocalDiscPrefix.length));
    }
    return names.sort();
}

/** Whether a descriptor is what the typed query is looking for. */
export function matchesQuery(descriptor, query) {
    if (!query) return true;
    const haystack = `${descriptor.title} ${descriptor.publisher} ${descriptor.detail}`.toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((word) => haystack.includes(word));
}
