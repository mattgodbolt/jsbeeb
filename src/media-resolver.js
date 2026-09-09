import { unzipDiscImage } from "./archive.js";
import { stringToUint8Array } from "./binary.js";
import { loadData } from "./loader.js";

/** Splits an image reference into its schema (empty for a bare name) and the image it names. */
export function splitImage(image) {
    const match = image.match(/(([^:]+):\/?\/?|[!^|])?(.*)/);
    return { schema: match[2] || match[1] || "", image: match[3] };
}

/**
 * Every schema a reference can start with: how it is served (`route`) and where the page says it
 * came from, as a media-catalogue source key (`source`) or as words (`phrase`). A reference
 * with no schema is a bare name from the built-in folder.
 */
export const Schemas = Object.freeze({
    "": { route: "folder", source: "builtin" },
    sth: { route: "sth", source: "sth" },
    "|": { route: "sth", source: "sth" },
    hfe: { route: "hfe", source: "hfe" },
    gd: { route: "drive", source: "gdrive" },
    local: { route: "browser", source: "browser" },
    "!": { route: "browser", source: "browser" },
    session: { route: "session", source: "session" },
    data: { route: "zipped-inline", phrase: "the URL" },
    b64data: { route: "inline", phrase: "the URL" },
    http: { route: "url", phrase: "the web" },
    https: { route: "url", phrase: "the web" },
    file: { route: "url", phrase: "a file" },
});

/** How a reference is served; a schema this page does not know is read as a folder name. */
export const routeOf = (ref) => (Schemas[splitImage(ref).schema] ?? Schemas[""]).route;

// Where a bare name is looked for, and which registered source serves the archive.
const Kinds = {
    disc: { folder: "discs", sth: "sth" },
    tape: { folder: "tapes", sth: "tapeSth" },
};

/** The image itself when `name` is a zip, else the bytes as given, either way as `{ name, data, ignored }`. */
export function openIfZip(name, data) {
    return /\.zip/i.test(name) ? unzipDiscImage(data) : { name, data, ignored: [] };
}

/**
 * Turns any image reference the URL can name into bytes, `{ name, data, ignored }`,
 * for a disc or a tape: the archives through the sources registered for them,
 * `data:` and `b64data:` inline, `http:`, `https:` and `file:` by URL, and a
 * bare name from the built-in folder. Zips are opened once, here. Nothing in
 * it needs a page, so a headless machine can load the same references.
 */
export class MediaResolver {
    constructor({ load = loadData } = {}) {
        this.sources = {};
        this.load = load;
    }

    /** Registers the fetcher behind an archive schema; each archive registers as it is constructed. */
    addSource(schema, fetcher) {
        this.sources[schema] = fetcher;
    }

    async resolve(kind, ref) {
        const { image } = splitImage(ref);
        const { folder, sth } = Kinds[kind];
        switch (routeOf(ref)) {
            case "sth":
                return this.source(sth)(image);
            case "hfe":
                return { name: image, data: await this.source("hfe")(image), ignored: [] };
            case "session":
                return this.source("session")(image);
            case "inline":
                return { name: "disk.ssd", data: stringToUint8Array(atob(image)), ignored: [] };
            case "zipped-inline":
                return unzipDiscImage(stringToUint8Array(atob(image)));
            case "url":
                // The URL may end in query parameters, which would upset the extension check.
                return openIfZip(new URL(ref).pathname.split("/").pop(), await this.load(ref));
            default:
                return openIfZip(image, await this.load(`${folder}/${image}`));
        }
    }

    source(schema) {
        const fetcher = this.sources[schema];
        if (!fetcher) throw new Error(`No ${schema} archive is available here`);
        return fetcher;
    }
}
