// Accesses STH archive via a proxy on the bbc.godbolt.org website
define(['utils', 'jquery', 'jsunzip'], function (utils, $, jsunzip) {
    "use strict";
    return function StairwayToHell(onStart, onCat, onError, tape) {
        var self = this;
        var baseUrl = tape ? "http://bbc.godbolt.org/sth/tapeimages/" : "http://bbc.godbolt.org/sth/diskimages/";

        var catalogUrl = "reclist.php?sort=name&filter=.zip";
        var catalog = [];

        self.populate = function () {
            onStart();
            if (catalog.length === 0) {
                var request = new XMLHttpRequest();
                request.open("GET", baseUrl + catalogUrl, true);
                request.onerror = function () {
                    if (onError) onError();
                };
                request.onload = function () {
                    var doc = $($.parseHTML(this.responseText, null, false));
                    doc.find("tr td:nth-child(3) a").each(function (_, link) {
                        var href = $(link).attr("href");
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
            var name = baseUrl + file;
            console.log("Loading ZIP from " + name);
            return utils.loadData(name).then(function (data) {
                var unzip = new jsunzip.JSUnzip();
                console.log("Attempting to unzip");
                var result = unzip.open(data);
                if (!result.status) {
                    throw new Error("Error unzipping ", result.error);
                }
                var uncompressed = null;
                var knownExtensions = {
                    'uef': true,
                    'ssd': true,
                    'dsd': true
                };
                var loadedFile;
                for (var f in unzip.files) {
                    var match = f.match(/.*\.([a-z]+)/i);
                    if (!match || !knownExtensions[match[1].toLowerCase()]) {
                        console.log("Skipping file", f);
                        continue;
                    }
                    if (uncompressed) {
                        console.log("Ignoring", f, "as already found a file");
                        continue;
                    }
                    loadedFile = f;
                    uncompressed = unzip.read(f);
                }
                if (!uncompressed) {
                    throw new Error("Couldn't find any compatible files in the archive");
                }
                if (!uncompressed.status) {
                    throw new Error("Failed to uncompress file '" + loadedFile + "' - " + uncompressed.error);
                }
                return uncompressed.data;
            });
        };
    };
});