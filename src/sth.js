import { unzipDiscImage } from "./archive.js";

// Always https, whatever the page was loaded over: the mirror redirects plain
// http, so following the page's protocol would cost a redirect on every request
// when developing over http, and Electron reports "file:" anyway.
const mirrorBase = "https://bbc.xania.org/archive/sth";

async function _fetchManifest(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Network response was not ok (${response.status})`);
    }
    const data = await response.json();
    if (!Array.isArray(data?.files)) {
        throw new Error("Invalid manifest: missing files array");
    }
    return data.files.map((f) => f.path).sort();
}

// Each path component is encoded individually so slashes survive but special
// characters in filenames (e.g. brackets in "Daxis[droids]-demo.zip") don't
// produce a malformed URL.
function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}

export class StairwayToHell {
    /** @param {{tapes?: boolean}} [what] the tape images rather than the disc images */
    constructor({ tapes = false } = {}) {
        this._baseUrl = `${mirrorBase}/${tapes ? "tape" : "disk"}images/`;
        this._catalog = [];
    }

    /** @returns {Promise<string[]>} every path in the archive, fetched the first time it is asked for */
    async catalogue() {
        if (this._catalog.length === 0) this._catalog = await _fetchManifest(this._baseUrl + "manifest.json");
        return this._catalog;
    }

    async fetch(file) {
        const url = this._baseUrl + encodePath(file);
        console.log("Loading ZIP from " + url);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Unable to load ${url}, http code ${response.status}`);
        try {
            return await unzipDiscImage(new Uint8Array(await response.arrayBuffer()));
        } catch (error) {
            console.error("Failed to fetch file:", error);
            throw error;
        }
    }
}
