import { Provenance, describe as describeHfe } from "../bbcdiscs.js";
import { Schemas, splitImage } from "../media-resolver.js";
import { findModel } from "../models.js";

/**
 * One shape for everything the media window can list, whichever source it
 * came from:
 *
 *   { ref, kind, title, publisher, detail, source, savesChanges, url?, requires? }
 *
 * `ref` is what loadDiscImage or loadTapeImage takes and what goes in the URL; `url` is a
 * page about the entry, when its source has one; `requires` is the machine the entry runs on,
 * as `{ model, coProcessor, name }`, when its source says.
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
    bitshifters: {
        name: "Bitshifters",
        phrase: "Bitshifters",
        title: "Demos and games released at bitshifters.github.io, each with the page that presents it",
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

// The site's manifest carries its own markup in a publisher or an author, a <span> or a link.
const stripTags = (text) => text.replace(/<[^>]*>/g, "");

/** What each `machine` the Bitshifters manifest names asks for, as the URL spells the model and its fitting. */
export const BitshiftersMachines = Object.freeze({
    Master: Object.freeze({ model: "Master", coProcessor: false, name: "BBC Master 128" }),
    MasterTurbo: Object.freeze({
        model: "Master",
        coProcessor: true,
        name: "BBC Master 128 with a 65C102 co-processor",
    }),
});

// The catalogue is described afresh on every listing; a machine outside the table is worth one line.
const unknownMachines = new Set();

function bitshiftersRequirement(machine) {
    if (machine === undefined) return undefined;
    const requires = Object.hasOwn(BitshiftersMachines, machine) ? BitshiftersMachines[machine] : undefined;
    if (!requires && !unknownMachines.has(machine)) {
        unknownMachines.add(machine);
        console.log(`Bitshifters names a machine this emulator has no table entry for: ${machine}`);
    }
    return requires;
}

/** Whether a model is of the kind a requirement names: any Master 128 for a Master, whichever filing system. */
export const modelSatisfies = (requires, model) => model.isMaster === findModel(requires.model).isMaster;

/** Whether a machine meets a requirement: the model's kind, with a Tube where the requirement has one. */
export function satisfiesRequirement(requires, { model, hasTube }) {
    return modelSatisfies(requires, model) && (hasTube || !requires.coProcessor);
}

export function describeBitshiftersEntry(file) {
    const detail = [file.type, file.machine, file.year, file.authors && stripTags(file.authors)];
    return {
        ref: `bitshifters:${file.path}`,
        kind: "disc",
        title: file.title || file.path,
        publisher: stripTags(file.publisher ?? ""),
        detail: detail.filter(Boolean).join(" · "),
        source: "bitshifters",
        savesChanges: false,
        url: file.url,
        requires: bitshiftersRequirement(file.machine),
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

// Among equal matches with one title: the user's own discs, then the sources with metadata
// (the authors' own releases, the flux captures) before the one without.
const SourceRank = { browser: 1, gdrive: 1, session: 1, bitshifters: 2, hfe: 2, hfeRebuilt: 3, sth: 4 };

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
