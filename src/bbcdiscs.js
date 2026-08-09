"use strict";

// Blobs are served with `Content-Encoding: br`, so the browser has already
// undone the compression by the time `fetch` resolves.
const mirrorBase = "https://bbc.xania.org/archive/bbcdiscs";

/**
 * How a disc reads in the picker. Several fingerprinted variants of one title
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
    constructor(onStart, onCat, onError, baseUrl = mirrorBase) {
        this._baseUrl = `${baseUrl}/hfe/`;
        this._catalogue = [];
        this._onStart = onStart;
        this._onCat = onCat;
        this._onError = onError;
    }

    async populate() {
        this._onStart();
        if (this._catalogue.length === 0) {
            try {
                const response = await fetch(`${this._baseUrl}manifest.json`);
                if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
                const data = await response.json();
                if (!Array.isArray(data?.files)) throw new Error("Invalid manifest: missing files array");
                this._catalogue = data.files;
            } catch (error) {
                console.error("Failed to fetch HFE archive catalogue:", error);
                if (this._onError) this._onError();
                return;
            }
        }
        if (this._onCat) this._onCat(this._catalogue);
    }

    /**
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
