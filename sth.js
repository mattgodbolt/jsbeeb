"use strict";

import * as utils from "./utils.js";
import $ from "jquery";

export function StairwayToHell(onStart, onCat, onError, tape) {
    const self = this;
    let baseUrl = document.location.protocol + "//www.stairwaytohell.com/bbc/archive/";
    if (tape) baseUrl += "tapeimages/";
    else baseUrl += "diskimages/";

    const catalogUrl = "reclist.php?sort=name&filter=.zip";
    const catalog = [];

    self.populate = function () {
        onStart();
        if (catalog.length === 0) {
            const request = new XMLHttpRequest();
            request.open("GET", baseUrl + catalogUrl, true);
            request.onerror = function () {
                if (onError) onError();
            };
            request.onload = function () {
                const doc = $($.parseHTML(this.responseText, null, false));
                doc.find("tr td:nth-child(3) a").each(function (_, link) {
                    const href = $(link).attr("href");
                    if (href.indexOf(".zip") > 0) catalog.push(href);
                });
                if (onCat) onCat(catalog);
            };
            request.send();
        } else {
            if (onCat) onCat(catalog);
        }
    };

    self.catalog = function () {
        return catalog;
    };

    self.fetch = function (file) {
        const name = baseUrl + file;
        console.log("Loading ZIP from " + name);
        return utils.loadData(name).then(function (data) {
            return utils.unzipDiscImage(data).data;
        });
    };
}
