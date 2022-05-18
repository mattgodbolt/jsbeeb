"use strict";
import _ from "underscore";
import * as utils from "./utils.js";
import { BaseDisc } from "./fdc.js";

export function GoogleDriveLoader() {
    var self = this;
    var MIME_TYPE = "application/vnd.jsbeeb.disc-image";
    var CLIENT_ID = "356883185894-bhim19837nroivv18p0j25gecora60r5.apps.googleusercontent.com";
    var SCOPES = "https://www.googleapis.com/auth/drive.file";
    var gapi = null;
    var BaseSsd = BaseDisc;

    self.initialise = function () {
        return new Promise(function (resolve) {
            // https://github.com/google/google-api-javascript-client/issues/319
            const gapiScript = document.createElement("script");
            gapiScript.src = "https://apis.google.com/js/client.js?onload=__onGapiLoad__";
            window.__onGapiLoad__ = function onGapiLoad() {
                gapi = window.gapi;
                gapi.client.load("drive", "v2", function () {
                    console.log("Google Drive: available");
                    resolve(true);
                });
            };
            document.body.appendChild(gapiScript);
        });
    };

    self.authorize = function (immediate) {
        return new Promise(function (resolve, reject) {
            console.log("Authorizing", immediate);
            gapi.auth.authorize(
                {
                    client_id: CLIENT_ID,
                    scope: SCOPES,
                    immediate: immediate,
                },
                function (authResult) {
                    if (authResult && !authResult.error) {
                        console.log("Google Drive: authorized");
                        resolve(true);
                    } else if (authResult && authResult.error && !immediate) {
                        reject(new Error(authResult.error));
                    } else {
                        console.log("Google Drive: Need to auth");
                        resolve(false);
                    }
                }
            );
        });
    };

    var boundary = "-------314159265358979323846";
    var delimiter = "\r\n--" + boundary + "\r\n";
    var close_delim = "\r\n--" + boundary + "--";

    function listFiles() {
        return new Promise(function (resolve) {
            var retrievePageOfFiles = function (request, result) {
                request.execute(function (resp) {
                    result = result.concat(resp.items);
                    var nextPageToken = resp.nextPageToken;
                    if (nextPageToken) {
                        request = gapi.client.drive.files.list({
                            pageToken: nextPageToken,
                        });
                        retrievePageOfFiles(request, result);
                    } else {
                        resolve(result);
                    }
                });
            };
            retrievePageOfFiles(
                gapi.client.drive.files.list({
                    q: "mimeType = '" + MIME_TYPE + "'",
                }),
                []
            );
        });
    }

    function saveFile(name, data, idOrNone) {
        var metadata = {
            title: name,
            parents: ["jsbeeb disc images"], // TODO: parents doesn't work; also should probably prevent overwriting this on every save
            mimeType: MIME_TYPE,
        };

        var str = utils.uint8ArrayToString(data);
        var base64Data = btoa(str);
        var multipartRequestBody =
            delimiter +
            "Content-Type: application/json\r\n\r\n" +
            JSON.stringify(metadata) +
            delimiter +
            "Content-Type: " +
            MIME_TYPE +
            "\r\n" +
            "Content-Transfer-Encoding: base64\r\n" +
            "\r\n" +
            base64Data +
            close_delim;

        var request = gapi.client.request({
            path: "/upload/drive/v2/files" + (idOrNone ? "/" + idOrNone : ""),
            method: idOrNone ? "PUT" : "POST",
            params: { uploadType: "multipart", newRevision: false },
            headers: {
                "Content-Type": 'multipart/mixed; boundary="' + boundary + '"',
            },
            body: multipartRequestBody,
        });
        return request;
    }

    function loadMetadata(fileId) {
        return gapi.client.drive.files.get({ fileId: fileId });
    }

    self.create = function (fdc, name) {
        console.log("Google Drive: creating disc image: '" + name + "'");
        var byteSize = utils.discImageSize(name).byteSize;
        var data = new Uint8Array(byteSize);
        utils.setDiscName(data, name);
        return saveFile(name, data).then(function (response) {
            var meta = response.result;
            return { fileId: meta.id, disc: makeDisc(fdc, data, meta) };
        });
    };

    function downloadFile(file) {
        if (file.downloadUrl) {
            return new Promise(function (resolve, reject) {
                var accessToken = gapi.auth.getToken().access_token;
                var xhr = new XMLHttpRequest();
                xhr.open("GET", file.downloadUrl, true);
                xhr.setRequestHeader("Authorization", "Bearer " + accessToken);
                xhr.overrideMimeType("text/plain; charset=x-user-defined");

                xhr.onload = function () {
                    if (xhr.status !== 200) {
                        reject(new Error("Unable to load '" + file.title + "', http code " + xhr.status));
                    } else if (typeof xhr.response !== "string") {
                        resolve(xhr.response);
                    } else {
                        resolve(utils.stringToUint8Array(xhr.response));
                    }
                };
                xhr.onerror = function () {
                    reject(new Error("Error sending request for " + file));
                };
                xhr.send();
            });
        } else {
            return Promise.resolve(null);
        }
    }

    function makeDisc(fdc, data, meta) {
        var flusher = null;
        var name = meta.title;
        if (meta.editable) {
            console.log("Making editable disc");
            flusher = _.debounce(function () {
                saveFile(this.name, this.data, meta.id).then(function () {
                    console.log("Saved ok");
                });
            }, 200);
        } else {
            console.log("Making read-only disc");
        }
        return new BaseSsd(fdc, name, data, flusher);
    }

    self.load = function (fdc, fileId) {
        var meta = false;
        return loadMetadata(fileId)
            .then(function (response) {
                meta = response.result;
                return downloadFile(response.result);
            })
            .then(function (data) {
                return makeDisc(fdc, data, meta);
            });
    };

    self.cat = listFiles;
}
