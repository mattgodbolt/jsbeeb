define(['jquery', 'utils', 'fdc'], function ($, utils, fdc) {
    "use strict";
    return function GoogleDriveLoader() {
        var self = this;
        var MIME_TYPE = 'application/vnd.jsbeeb.disc-image';
        var CLIENT_ID = '356883185894-bhim19837nroivv18p0j25gecora60r5.apps.googleusercontent.com';
        var SCOPES = 'https://www.googleapis.com/auth/drive';
        var gapi = null;
        var baseSsd = fdc.baseSsd;

        self.initialise = function () {
            return new Promise(function (resolve) {
                require(['gapi'], function (g) {
                    gapi = g;
                    gapi.client.load('drive', 'v2', function () {
                        console.log("Google Drive: available");
                        resolve(true);
                    });
                });
            });
        };

        self.authorize = function (immediate) {
            return new Promise(function (resolve, reject) {
                console.log("Authorizing", immediate);
                gapi.auth.authorize({
                        'client_id': CLIENT_ID,
                        'scope': SCOPES,
                        'immediate': immediate
                    }, function (authResult) {
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

        var boundary = '-------314159265358979323846';
        var delimiter = "\r\n--" + boundary + "\r\n";
        var close_delim = "\r\n--" + boundary + "--";

        function listFiles() {
            return new Promise(function (resolve, reject) {
                var retrievePageOfFiles = function (request, result) {
                    request.execute(function (resp) {
                        result = result.concat(resp.items);
                        var nextPageToken = resp.nextPageToken;
                        if (nextPageToken) {
                            request = gapi.client.drive.files.list({
                                'pageToken': nextPageToken
                            });
                            retrievePageOfFiles(request, result);
                        } else {
                            resolve(result);
                        }
                    });
                };
                retrievePageOfFiles(gapi.client.drive.files.list({
                    'q': "mimeType = '" + MIME_TYPE + "'"
                }), []);
            });
        }

        function createFile(name, data) {
            var metadata = {
                'title': name + '.ssd',
                'parents': ["jsbeeb disc images"],
                'mimeType': MIME_TYPE
            };

            var base64Data = btoa(data);
            var multipartRequestBody =
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: ' + MIME_TYPE + '\r\n' +
                'Content-Transfer-Encoding: base64\r\n' +
                '\r\n' +
                base64Data +
                close_delim;

            var request = gapi.client.request({
                'path': '/upload/drive/v2/files',
                'method': 'POST',
                'params': {'uploadType': 'multipart'},
                'headers': {
                    'Content-Type': 'multipart/mixed; boundary="' + boundary + '"'
                },
                'body': multipartRequestBody
            });
            return request;
        }

        function save(fileId, data) {
            var str = "";
            for (var i = 0; i < data.length; ++i) str += String.fromCharCode(data[i]);
            var request = gapi.client.request({
                'path': '/upload/drive/v2/files/' + fileId,
                'method': 'PUT',
                'params': {
                    'uploadType': 'media',
                    'newRevision': false
                },
                'headers': {
                    'Content-Type': MIME_TYPE
                },
                'body': str
            });
            return request;
        }

        function loadMetadata(fileId) {
            return gapi.client.drive.files.get({'fileId': fileId});
        }

        self.create = function (fdc, name) {
            console.log("Creating disc image");
            var data = new Uint8Array(100 * 1024);
            for (var i = 0; i < Math.max(12, name.length); ++i)
                data[i] = name.charCodeAt(i) & 0xff;
            return createFile(name, data)
                .then(function (response) {
                    var meta = response.result;
                    return {fileId: meta.id, disc: makeDisc(fdc, data, meta.id, true)};
                });
        };

        function downloadFile(file) {
            if (file.downloadUrl) {
                return new Promise(function (resolve, reject) {
                    var accessToken = gapi.auth.getToken().access_token;
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', file.downloadUrl, true);
                    xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
                    xhr.overrideMimeType('text/plain; charset=x-user-defined');

                    xhr.onload = function () {
                        if (xhr.status !== 200) {
                            reject(new Error("Unable to load " + file.title + ", http code " + xhr.status));
                        } else if (typeof(xhr.response) !== "string") {
                            resolve(xhr.response);
                        } else {
                            resolve(utils.makeBinaryData(xhr.response));
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

        function makeDisc(fdc, data, fileId, editable) {
            var flusher = null;
            if (editable) {
                flusher = _.debounce(function () {
                    save(fileId, data).then(function () {
                        console.log("Saved ok");
                    });
                }, 2000);
            }
            return baseSsd(fdc, data, editable, flusher);
        }

        self.load = function (fdc, fileId) {
            var editable = false;
            return loadMetadata(fileId)
                .then(function (response) {
                    editable = response.result.editable;
                    return downloadFile(response.result);
                })
                .then(function (data) {
                    return makeDisc(fdc, data, fileId, editable);
                });
        };

        self.cat = listFiles;
    };
});
