"use strict";

import * as utils from "./utils.js";
import $ from "jquery";

const catalogUrl = "reclist.php?sort=name&filter=.zip";
const sthArchive = "www.stairwaytohell.com/bbc/archive";

export class StairwayToHell {
    constructor(onStart, onCat, onError, tape) {
        this._baseUrl = `${document.location.protocol}//${sthArchive}/${tape ? "tape" : "disk"}images/`;
        this._catalog = [];
        this._onStart = onStart;
        this._onCat = onCat;
        this._onError = onError;
    }

    populate() {
        this._onStart();
        if (this._catalog.length === 0) {
            const request = new XMLHttpRequest();
            request.open("GET", this._baseUrl + catalogUrl, true);
            request.onerror = () => {
                if (this._onError) this._onError();
            };
            request.onload = () => {
                const doc = $($.parseHTML(request.responseText, null, false));
                doc.find("tr td:nth-child(3) a").each((_, link) => {
                    const href = $(link).attr("href");
                    if (href.indexOf(".zip") > 0) this._catalog.push(href);
                });
                if (this._onCat) this._onCat(this._catalog);
            };
            request.send();
        } else {
            if (this._onCat) this._onCat(this._catalog);
        }
    }

    async fetch(file) {
        const name = this._baseUrl + file;
        console.log("Loading ZIP from " + name);
        const data = await utils.loadData(name);
        return utils.unzipDiscImage(data).data;
    }
}
