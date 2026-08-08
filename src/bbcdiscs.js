"use strict";

// Sketch: the data source for browsing scarybeasts' mirrored HFE archive.
// Not wired into main.js yet.
//
// The difference from sth.js is that these blobs are HFE images served with
// `Content-Encoding: br`, so the browser decodes them and `fetch()` hands back
// the image itself. There is nothing to unzip, and `.hfe` already routes to the
// HFE loader via guessDiscTypeFromName.

const mirrorBase = "https://bbc.xania.org/archive/bbcdiscs";

/**
 * How a disc is described in the picker. The sheet's own columns are what make
 * this archive worth browsing: several fingerprinted variants of one title sit
 * side by side, and only the metadata tells them apart.
 *
 * @param {object} file manifest entry
 * @returns {string}
 */
export function describe(file) {
    const parts = [file.publisher, file.title].filter(Boolean);
    const detail = [file.disc, file.tracks?.join("/"), file.variant && `v${file.variant}`].filter(Boolean);
    return detail.length ? `${parts.join(" - ")} (${detail.join(", ")})` : parts.join(" - ");
}

export class BbcDiscArchive {
    /** @param {string} [baseUrl] where the mirror lives, to point at a test prefix. */
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
                console.error("Failed to fetch catalogue:", error);
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
        const response = await fetch(this._baseUrl + encodeURIComponent(path));
        if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
    }
}
