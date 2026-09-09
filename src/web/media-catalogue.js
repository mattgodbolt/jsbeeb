import { Provenance, describe as describeHfe } from "../bbcdiscs.js";
import { Schemas, splitImage } from "../media-resolver.js";

/**
 * One shape for everything the media window can list, whichever source it
 * came from:
 *
 *   { ref, kind, title, publisher, detail, source, savesChanges }
 *
 * `ref` is what loadDiscImage or loadTapeImage takes and what goes in the URL.
 */

// `name` heads a chip; `phrase` sits mid-sentence in a slot's status line.
export const Sources = Object.freeze({
    builtin: { name: "Built in", phrase: "built in", title: "The example discs that ship with jsbeeb" },
    sth: { name: "STH archive", phrase: "STH archive", title: "The Stairway To Hell mirror" },
    hfe: {
        name: "HFE archive",
        phrase: "HFE archive",
        title: "Flux captures of real discs, with title, publisher, side and pitch",
    },
    hfeRebuilt: {
        name: "HFE rebuilt",
        phrase: "HFE archive",
        title: "Discs rebuilt from a sector dump: the data is right, the surface around it is inferred",
    },
    gdrive: { name: "Google Drive", phrase: "Google Drive", title: "Your Google Drive; changes are kept there" },
    browser: {
        name: "This browser",
        phrase: "this browser",
        title: "Discs kept in this browser's storage; changes are kept",
    },
    session: {
        name: "This session",
        phrase: "a file opened this session",
        title: "Files opened this session; they cannot be named in the URL",
    },
});

export const sourceName = (source) => Sources[source]?.name ?? source;

/** Where a URL reference came from, in words, or null when the URL names nothing. */
export function sourceOf(ref) {
    if (!ref) return null;
    const schema = Schemas[splitImage(ref).schema];
    return Sources[schema?.source]?.phrase ?? schema?.phrase ?? null;
}

/** A descriptor for a bare reference, as the URL or the desktop menu gives one: known by its file name. */
export function describeRef(ref, kind) {
    const { schema, image } = splitImage(ref);
    return {
        ref,
        kind,
        title: image.split("/").pop(),
        publisher: "",
        detail: "",
        source: Schemas[schema]?.source ?? Schemas[schema]?.phrase ?? schema,
        savesChanges: false,
    };
}

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

export function describeHfeEntry(file) {
    const { title, publisher, detail } = describeHfe(file);
    return {
        ref: `hfe:${file.path}`,
        kind: "disc",
        title,
        publisher,
        detail,
        source: file.provenance === Provenance.Reconstructed ? "hfeRebuilt" : "hfe",
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

// How well one word of a query fits a descriptor: the title itself, a word of the title, somewhere
// in the title, or only in the publisher or detail. Zero is no fit.
const WholeTitle = 8;
const TitleStart = 4;
const TitleWordStart = 3;
const InTitle = 2;
const Elsewhere = 1;

const wordsOf = (text) =>
    text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);

function scoreWord(descriptor, word) {
    const title = descriptor.title.toLowerCase();
    if (title === word) return WholeTitle;
    if (title.startsWith(word)) return TitleStart;
    if (wordsOf(title).some((titleWord) => titleWord.startsWith(word))) return TitleWordStart;
    if (title.includes(word)) return InTitle;
    if (`${descriptor.publisher} ${descriptor.detail}`.toLowerCase().includes(word)) return Elsewhere;
    return 0;
}

/**
 * How well a descriptor answers the typed query: zero when some word of the
 * query is nowhere in it, otherwise higher the closer the title itself is to
 * what was typed, so "Exile" outranks "CHT_Exile-Mapper" for "exil".
 */
export function scoreQuery(descriptor, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return 1;
    let score = 0;
    for (const word of words) {
        const wordScore = scoreWord(descriptor, word);
        if (wordScore === 0) return 0;
        score += wordScore;
    }
    return score;
}

/** Whether a descriptor is what the typed query is looking for. */
export const matchesQuery = (descriptor, query) => scoreQuery(descriptor, query) > 0;

// Among equal matches with one title: the user's own discs, then the archive with metadata
// before the one without.
const SourceRank = { browser: 1, gdrive: 1, session: 1, hfe: 2, hfeRebuilt: 3, sth: 4 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The list's order for a query: the best matches first, then by title across every source so
 * that the same title from two archives sits together, the richer source first.
 */
export function compareForQuery(query) {
    // A sort asks for each score many times over; the query is fixed, so each is worked out once.
    const scores = new Map();
    const scoreOf = (d) => {
        if (!scores.has(d)) scores.set(d, scoreQuery(d, query));
        return scores.get(d);
    };
    return (a, b) =>
        scoreOf(b) - scoreOf(a) ||
        (b.source === "builtin") - (a.source === "builtin") ||
        collator.compare(a.title, b.title) ||
        (SourceRank[a.source] ?? 9) - (SourceRank[b.source] ?? 9) ||
        collator.compare(a.publisher, b.publisher) ||
        collator.compare(a.detail, b.detail);
}
