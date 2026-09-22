const SiteBase = "https://bitshifters.github.io/content";

/**
 * The discs Bitshifters publish at bitshifters.github.io: their own demos and
 * games, and the archived releases of other BBC Micro groups, each with the
 * page that presents it.
 */
export class BitshiftersArchive {
    /** @param {string} [baseUrl] where the site keeps its content, to point at a test prefix */
    constructor(baseUrl = SiteBase) {
        this._baseUrl = `${baseUrl}/`;
        this._catalogue = [];
        this._loaded = false;
    }

    /** @returns {Promise<object[]>} every manifest entry, fetched the first time it is asked for */
    async catalogue() {
        if (this._loaded) return this._catalogue;
        const response = await fetch(`${this._baseUrl}manifest.json`);
        if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data?.files)) throw new Error("Invalid manifest: missing files array");
        this._catalogue = data.files;
        this._loaded = true;
        return this._catalogue;
    }

    /**
     * @param {string} path a manifest entry's `path`, an SSD or DSD image
     * @returns {Promise<Uint8Array>} the image
     */
    async fetch(path) {
        const url = this._baseUrl + encodeURIComponent(path);
        console.log("Loading disc from " + url);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
    }
}
