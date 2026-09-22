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
        this._catalogue = null;
    }

    /**
     * @returns {Promise<object[]>} every manifest entry, fetched once however many ask at
     *     the same time; a failed fetch is forgotten so the next asker tries again
     */
    catalogue() {
        if (!this._catalogue)
            this._catalogue = this._fetchCatalogue().catch((error) => {
                this._catalogue = null;
                throw error;
            });
        return this._catalogue;
    }

    async _fetchCatalogue() {
        const response = await fetch(`${this._baseUrl}manifest.json`);
        if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data?.files)) throw new Error("Invalid manifest: missing files array");
        return data.files;
    }

    /**
     * @param {string} path a manifest entry's `path`, an SSD or DSD image
     * @returns {Promise<Uint8Array>} the image
     */
    async fetch(path) {
        const url = this._baseUrl + path.split("/").map(encodeURIComponent).join("/");
        console.log("Loading disc from " + url);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
    }
}
