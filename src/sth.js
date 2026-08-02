"use strict";

import * as utils from "./utils.js";

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
    constructor(onStart, onCat, onError, tape) {
        this._baseUrl = `${mirrorBase}/${tape ? "tape" : "disk"}images/`;
        this._catalog = [];
        this._onStart = onStart;
        this._onCat = onCat;
        this._onError = onError;
    }

    async populate() {
        this._onStart();
        if (this._catalog.length === 0) {
            try {
                this._catalog = await _fetchManifest(this._baseUrl + "manifest.json");
            } catch (error) {
                console.error("Failed to fetch catalog:", error);
                if (this._onError) this._onError();
                return;
            }
        }
        if (this._onCat) this._onCat(this._catalog);
    }

    async fetch(file) {
        const name = this._baseUrl + encodePath(file);
        console.log("Loading ZIP from " + name);
        const response = await fetch(name);
        if (!response.ok) throw new Error("Network response was not ok");
        try {
            return (await utils.unzipDiscImage(new Uint8Array(await response.arrayBuffer()))).data;
        } catch (error) {
            console.error("Failed to fetch file:", error);
            throw error;
        }
    }
}
