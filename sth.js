// Accesses STH archive via a proxy on the bbc.godbolt.org website
function StairwayToHell(onCat) {
    "use strict";
    var self = this;
    var baseUrl = "http://bbc.godbolt.org/sth/diskimages/";

    var catalogUrl = "reclist.php?sort=name&filter=.zip";
    var catalog = [];

    var request = new XMLHttpRequest();
    request.open("GET", baseUrl + catalogUrl, true);
    request.onload = function() {
        var doc = $($.parseHTML(this.responseText, null, false));
        var first = true;
        doc.find("tr td:nth-child(3) a").each(function(_, link) {
            var href = $(link).attr("href");
            if (href.indexOf(".zip") > 0) catalog.push(href);
        });
        if (onCat) onCat(catalog);
    };
    request.send();

    self.catalog = function() {
        return catalog;
    };

    self.fetch = function(file) {
        var name = baseUrl + file;
        console.log("Loading ZIP from " + name);
        var request = new XMLHttpRequest();
        request.open("GET", name, false);
        request.overrideMimeType('text/plain; charset=x-user-defined');
        request.send(null);
        if (request.status != 200) {
            console.log("Failed:", request.status);
            return null;
        }
        var len = request.response.length;
        var data = new Uint8Array(len);
        for (var i = 0; i < len; ++i) data[i] = request.response.charCodeAt(i) & 0xff;
        var unzip = new JSUnzip();
        console.log("Attempting to unzip");
        var result = unzip.open(data);
        if (!result.status) {
            console.log("Error unzipping ", result.error);
            return null;
        }
        var uncompressed = null;
        for (var f in unzip.files) {
            if (uncompressed) {
                console.log("Ignoring", f, "as already found a file");
                continue;
            }
            console.log(f);
            uncompressed = unzip.read(f);
        }
        if (!uncompressed) {
            console.log("Didn't find any files :(");
            return null;
        }
        if (!uncompressed.status) {
            console.log("Failed to uncompress", uncompressed.error);
        }
        return uncompressed.data;
    }
}

