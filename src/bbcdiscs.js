const mirrorBase = "https://bbc.xania.org/archive/bbcdiscs";

/** How a disc came to be an image, which is the difference between the archives it came from. */
export const Provenance = {
    /** Read off the disc itself, by flux capture. */
    Captured: "captured",
    /** Rebuilt from a sector dump, so the surface around the data is inferred. */
    Reconstructed: "reconstructed",
};

// Numeric so a "Disc 2" would sort before a "Disc 10" rather than after it,
// and case-insensitive so a lower-cased title stays with its neighbours.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Order the list by what someone is looking for, which is the disc's name.
 * The catalogue arrives grouped by publisher, so it has to be sorted here; the
 * remaining keys only settle ties, keeping a title's variants together and in
 * a stable order rather than the one the catalogue happens to list them in.
 */
export const byTitle = (a, b) =>
    collator.compare(a.title || a.path, b.title || b.path) ||
    collator.compare(a.publisher || "", b.publisher || "") ||
    collator.compare(a.disc || "", b.disc || "") ||
    collator.compare(a.variant || "", b.variant || "");

/**
 * How a disc reads in the list. Several fingerprinted variants of one title
 * sit next to each other, so the title alone doesn't identify a disc.
 *
 * @param {object} file manifest entry
 * @returns {{title: string, publisher: string, detail: string}}
 */
export function describe(file) {
    const detail = [file.disc, file.tracks?.join(", "), file.variant && `v${file.variant}`].filter(Boolean);
    return {
        title: file.title || file.path,
        publisher: file.publisher ?? "",
        detail: detail.join(" · "),
    };
}

export class BbcDiscArchive {
    /** @param {string} [baseUrl] where the mirror lives, to point at a test prefix */
    constructor(baseUrl = mirrorBase) {
        this._baseUrl = `${baseUrl}/hfe/`;
        this._catalogue = [];
        this._loaded = false;
    }

    /** @returns {Promise<object[]>} every manifest entry, sorted by title, fetched the first time it is asked for */
    async catalogue() {
        // Tracked separately from the catalogue: an archive can legitimately be
        // empty, and an empty array would mean "fetch it again" every time.
        if (this._loaded) return this._catalogue;
        const response = await fetch(`${this._baseUrl}manifest.json`);
        if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data?.files)) throw new Error("Invalid manifest: missing files array");
        this._catalogue = data.files
            // The captured discs were published before provenance was recorded.
            .map((file) => ({ ...file, provenance: file.provenance ?? Provenance.Captured }))
            .sort(byTitle);
        this._loaded = true;
        return this._catalogue;
    }

    /**
     * Nothing to unzip, unlike sth.js: blobs are stored compressed and served
     * with `Content-Encoding: br`, which the browser has undone by the time
     * this resolves.
     *
     * @param {string} path a manifest entry's `path`
     * @returns {Promise<Uint8Array>} the HFE image
     */
    async fetch(path) {
        const url = this._baseUrl + encodeURIComponent(path);
        console.log("Loading HFE from " + url);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
    }
}
