"use strict";

import * as utils from "./utils.js";

const catalogUrl = "reclist.php?sort=name&filter=.zip";
const sthArchive = "www.stairwaytohell.com/bbc/archive";

async function _fetchAndParseCatalog(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error("Network response was not ok");
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(await response.text(), "text/html");
    const result = [];
    doc.querySelectorAll("tr td:nth-child(3) a").forEach((link) => {
        const href = link.getAttribute("href");
        if (href.indexOf(".zip") > 0) result.push(href);
    });
    result.sort();
    return result;
}

export class StairwayToHell {
    constructor(onStart, onCat, onError, tape) {
        this._baseUrl = `${document.location.protocol}//${sthArchive}/${tape ? "tape" : "disk"}images/`;
        this._catalog = [];
        this._onStart = onStart;
        this._onCat = onCat;
        this._onError = onError;
    }

    async populate() {
        this._onStart();
        if (this._catalog.length === 0) {
            try {
                this._catalog = await _fetchAndParseCatalog(this._baseUrl + catalogUrl);
            } catch (error) {
                console.error("Failed to fetch catalog:", error);
                if (this._onError) this._onError();
                return;
            }
        }
        if (this._onCat) this._onCat(this._catalog);
    }

    async fetch(file) {
        const name = this._baseUrl + file;
        console.log("Loading ZIP from " + name);
        const response = await fetch(name);
        if (!response.ok) throw new Error("Network response was not ok");
        try {
            return utils.unzipDiscImage(new Uint8Array(await response.arrayBuffer())).data;
        } catch (error) {
            console.error("Failed to fetch file:", error);
            throw error;
        }
    }
}
