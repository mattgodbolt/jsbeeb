import { Provenance, describe as describeHfe } from "../bbcdiscs.js";
import { Schemas, splitImage } from "../media-resolver.js";
import { findModel } from "../models.js";
import { Parameters } from "./parameters.js";

/**
 * One shape for everything the media window can list, whichever source it
 * came from:
 *
 *   { ref, kind, title, publisher, detail, source, savesChanges, url?, requires? }
 *
 * `ref` is what loadDiscImage or loadTapeImage takes and what goes in the URL; `url` is a
 * page about the entry, when its source has one; `requires` is the machine the entry runs on,
 * from `requirementOf`, when its source says.
 */

// `name` heads a chip; `phrase` sits mid-sentence in a slot's status line. A `personal` source holds
// the user's own media, which analytics names only by its source.
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
    github: {
        name: "GitHub",
        phrase: "GitHub",
        title: "Games and demos from their authors' GitHub repos, each with a link to its repo",
    },
    gdrive: {
        name: "Google Drive",
        phrase: "Google Drive",
        title: "Your Google Drive; changes are kept there",
        personal: true,
    },
    browser: {
        name: "This browser",
        phrase: "this browser",
        title: "Discs kept in this browser's storage; changes are kept",
        personal: true,
    },
    session: {
        name: "This session",
        phrase: "a file opened this session",
        title: "Files opened this session; they cannot be named in the URL",
        personal: true,
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

/** The machines a manifest may name as what a disc needs: model as the URL spells it, co-processor, user-facing name. */
export const MachineRequirements = Object.freeze({
    Master: Object.freeze({ model: "Master", coProcessor: false, name: "BBC Master 128" }),
    MasterTurbo: Object.freeze({
        model: "Master",
        coProcessor: true,
        name: "BBC Master 128 with a 65C102 co-processor",
    }),
});

/** A descriptor's `requires` for a manifest's machine name, or undefined for a name outside the table. */
const machineRequirement = (machine) =>
    Object.hasOwn(MachineRequirements, machine) ? MachineRequirements[machine] : undefined;

// Looked up when asked, since parameters.js imports this module by way of analytics-filters.js.
const settingNeededAs = (name) =>
    typeof name === "string"
        ? Object.entries(Parameters).find(([, { neededAs }]) => neededAs === name)?.[0]
        : undefined;

/**
 * A descriptor's `requires` for a manifest entry's `machine` and the fittings it `needs`, or undefined for neither; a
 * name outside `MachineRequirements` or the Parameters' `neededAs` is no requirement. A requirement with fittings has
 * their names as `needs` and the settings that fit them as `fittings`, and leaves the model as it is unless it names a
 * machine too.
 */
export function requirementOf({ machine, needs }) {
    const required = machineRequirement(machine);
    const named = [...new Set(Array.isArray(needs) ? needs : [])].filter((name) => settingNeededAs(name));
    if (named.length === 0) return required;
    return {
        ...required,
        needs: named,
        fittings: Object.fromEntries(named.map((name) => [settingNeededAs(name), true])),
    };
}

const withArticle = (name) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

/** What the user is told a requirement is, on a machine that is `model` now: "BBC Master 128 with a VideoNuLA". */
export function requirementName({ name, needs = [] }, model) {
    const machine = name ?? model.name;
    if (needs.length === 0) return machine;
    return `${machine}${machine.includes(" with ") ? " and" : " with"} ${needs.map(withArticle).join(" and ")}`;
}

/**
 * Whether a machine is the one a requirement names: that model, with a Tube if and only if it says so, and every
 * fitting it needs among the settings the machine was started with (`fitted`).
 */
export function satisfiesRequirement(requires, { model, hasTube, fitted = {} }) {
    return (
        (requires.model === undefined || (model === findModel(requires.model) && hasTube === requires.coProcessor)) &&
        Object.entries(requires.fittings ?? {}).every(([setting, value]) => fitted[setting] === value)
    );
}

// The site's manifest carries its own markup in a publisher or an author, a <span> or a link.
const stripTags = (text) => text.replace(/<[^>]*>/g, "");

const manifestDetail = ({ type, machine, year }, authors) => [type, machine, year, authors].filter(Boolean).join(" · ");

export function describeBitshiftersEntry(file) {
    return {
        ref: `bitshifters:${file.path}`,
        kind: "disc",
        title: file.title || file.path,
        publisher: stripTags(file.publisher ?? ""),
        detail: manifestDetail(file, file.authors && stripTags(file.authors)),
        source: "bitshifters",
        savesChanges: false,
        url: file.url,
        requires: requirementOf(file),
    };
}

export function describeGitHubEntry(entry) {
    return {
        ref: `github:${entry.repo}${entry.ref ? `@${entry.ref}` : ""}/${entry.path}`,
        kind: "disc",
        title: entry.title,
        publisher: entry.publisher,
        detail: manifestDetail(entry, entry.authors),
        source: "github",
        savesChanges: false,
        url: entry.url ?? `https://github.com/${entry.repo}`,
        requires: requirementOf(entry),
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

const OrdinalSuffixes = { one: "st", two: "nd", few: "rd", other: "th" };
const englishOrdinals = new Intl.PluralRules("en", { type: "ordinal" });
const ordinal = (n) => `${n}${OrdinalSuffixes[englishOrdinals.select(n)]}`;

/**
 * A file opened this session. `sameName` places it among the files of its kind opened under
 * the same name, in the order they were opened, so that rows with one title can be told apart.
 */
export const describeSessionFile = (key, name, kind, sameName = { order: 1, count: 1 }) => ({
    ref: `session:${key}`,
    kind,
    title: name,
    publisher: "",
    detail:
        sameName.count > 1
            ? `opened this session, ${ordinal(sameName.order)} of ${sameName.count}`
            : "opened this session",
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

const RecentKey = "recentMedia";
const MaxRecent = 8;

const sameEntry = (a, b) => a.ref === b.ref && a.kind === b.kind;
const outlivesSession = ({ ref }) => !ref.startsWith("session:");

/**
 * What was loaded most recently, newest first, by reference and kind: up to eight that are kept
 * in the browser's storage across visits, and up to eight files opened this session, which no
 * later visit could load. Storage that refuses only means the list does not outlive the page.
 */
export class RecentMedia {
    constructor(storage = () => window.localStorage) {
        this.storage = storage;
        this.entries = this.read();
    }

    read() {
        try {
            const entries = JSON.parse(this.storage().getItem(RecentKey) ?? "[]");
            return Array.isArray(entries) ? entries.filter(outlivesSession).slice(0, MaxRecent) : [];
        } catch (error) {
            console.warn("Could not read the recently loaded media:", error);
            return [];
        }
    }

    note(ref, kind) {
        const entry = { ref, kind };
        const newestFirst = [entry, ...this.entries.filter((other) => !sameEntry(other, entry))];
        const kept = newestFirst.filter(outlivesSession).slice(0, MaxRecent);
        const opened = newestFirst.filter((other) => !outlivesSession(other)).slice(0, MaxRecent);
        this.entries = newestFirst.filter((other) => kept.includes(other) || opened.includes(other));
        try {
            this.storage().setItem(RecentKey, JSON.stringify(kept));
        } catch (error) {
            console.warn("Could not keep the recently loaded media:", error);
        }
    }

    /** Where a descriptor stands in the list, newest at 0, or -1 when it was not loaded recently. */
    rank(descriptor) {
        return this.entries.findIndex((entry) => sameEntry(entry, descriptor));
    }
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
const SourceRank = { browser: 1, gdrive: 1, session: 1, bitshifters: 2, github: 2, hfe: 2, hfeRebuilt: 3, sth: 4 };

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
