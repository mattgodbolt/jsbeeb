import { unzipDiscImage } from "./archive.js";
import { stringToUint8Array } from "./binary.js";
import { loadData } from "./loader.js";

/** Splits an image reference into its schema (empty for a bare name) and the image it names. */
export function splitImage(image) {
    const match = image.match(/(([^:]+):\/?\/?|[!^|])?(.*)/);
    return { schema: match[2] || match[1] || "", image: match[3] };
}

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
        const { schema, image } = splitImage(ref);
        const { folder, sth } = Kinds[kind];
        switch (schema) {
            case "|":
            case "sth":
                return this.source(sth)(image);
            case "hfe":
                return { name: image, data: await this.source("hfe")(image), ignored: [] };
            case "b64data":
                return { name: "disk.ssd", data: stringToUint8Array(atob(image)), ignored: [] };
            case "data":
                return unzipDiscImage(stringToUint8Array(atob(image)));
            case "http":
            case "https":
            case "file":
                // The URL may end in query parameters, which would upset the extension check.
                return openIfZip(new URL(ref).pathname, await this.load(ref));
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
