"use strict";

import _ from "underscore";
import * as utils from "./utils.js";
import { discFor } from "./fdc.js";

const MIME_TYPE = "application/vnd.jsbeeb.disc-image";
const CLIENT_ID = "356883185894-bhim19837nroivv18p0j25gecora60r5.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
const FILE_FIELDS = "id,name,capabilities";
const PARENT_FOLDER_NAME = "jsbeeb disc images";

const boundary = "-------314159265358979323846";
const delimiter = `\r
--${boundary}\r
`;
const close_delim = `\r
--${boundary}--`;

export class GoogleDriveLoader {
    constructor() {
        this.gapi = null;
        this.authorized = false;
        this.parentFolderId = undefined;
    }

    async initialise() {
        console.log("Creating GAPI");
        this.gapi = await new Promise((resolve) => {
            // https://github.com/google/google-api-javascript-client/issues/319
            const gapiScript = document.createElement("script");
            gapiScript.src = "https://apis.google.com/js/api.js";
            gapiScript.onload = function onGapiLoad() {
                resolve(window.gapi);
            };
            document.body.appendChild(gapiScript);
        });
        console.log("Got GAPI, creating token client");
        this.tokenClient = await new Promise((resolve) => {
            // https://github.com/google/google-api-javascript-client/issues/319
            const gsiScript = document.createElement("script");
            gsiScript.src = "https://accounts.google.com/gsi/client";
            gsiScript.onload = function onGsiLoad() {
                resolve(
                    window.google.accounts.oauth2.initTokenClient({
                        client_id: CLIENT_ID,
                        scope: SCOPES,
                        error_callback: "", // defined later
                        callback: "", // defined later
                    }),
                );
            };
            document.body.appendChild(gsiScript);
        });
        console.log("Token client created, loading client");

        await this.gapi.load("client", async () => {
            console.log("Client loaded; initialising GAPI");
            await this.gapi.client.init({
                discoveryDocs: [DISCOVERY_DOC],
            });
            console.log("GAPI initialised");
        });
        console.log("Google Drive: available");
        return true;
    }

    authorize(imm) {
        if (this.authorized) return true;
        if (imm) return false;
        return new Promise((resolve, reject) => {
            console.log("Authorizing...");
            this.tokenClient.callback = (resp) => {
                if (resp.error !== undefined) reject(resp);
                console.log("Authorized OK");
                this.authorized = true;
                resolve(true);
            };
            this.tokenClient.error_callback = (resp) => {
                console.log(`Token client failure: ${resp.type}; failed to authorize`);
                reject(new Error(`Token client failure: ${resp.type}; failed to authorize`));
            };
            this.tokenClient.requestAccessToken({ select_account: false });
        });
    }

    async listFiles() {
        let response = await this.gapi.client.drive.files.list({
            q: `mimeType = '${MIME_TYPE}'`,
        });
        let result = response.result.files;
        while (response.result.nextPageToken) {
            response = await this.gapi.client.drive.files.list({
                pageToken: response.result.nextPageToken,
            });
            result = result.concat(response.result.files);
        }
        return result;
    }

    async _findOrCreateParentFolder() {
        // Not sure why this doesn't find Matt's pre-existing "jsbeeb disc images" folder, but this will have to do.
        const list = await this.gapi.client.drive.files.list({
            q: `name = '${PARENT_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            corpora: "user",
        });
        if (list.result.files.length === 1) {
            console.log("Found existing parent folder");
            return list.result.files[0].id;
        }
        console.log(`Creating parent folder ${PARENT_FOLDER_NAME}`);
        const file = await this.gapi.client.drive.files.create({
            resource: {
                name: PARENT_FOLDER_NAME,
                mimeType: "application/vnd.google-apps.folder",
            },
            fields: "id",
        });
        console.log("Folder Id:", file.result.id);
        return file.result.id;
    }

    async saveFile(name, data, idOrNone) {
        if (this.parentFolderId === undefined) {
            this.parentFolderId = await this._findOrCreateParentFolder();
        }
        const metadata = {
            name,
            parents: [this.parentFolderId],
            mimeType: MIME_TYPE,
        };

        // Note to self we can't upload data using create()
        // https://stackoverflow.com/questions/34905363/create-file-with-google-drive-api-v3-javascript
        const str = utils.uint8ArrayToString(data);
        const base64Data = btoa(str);
        const multipartRequestBody = `${delimiter}Content-Type: application/json\r
\r
${JSON.stringify(metadata)}${delimiter}Content-Type: ${MIME_TYPE}\r
Content-Transfer-Encoding: base64\r
\r
${base64Data}${close_delim}`;

        return this.gapi.client.request({
            path: `/upload/drive/v3/files${idOrNone ? `/${idOrNone}` : ""}`,
            method: idOrNone ? "PATCH" : "POST",
            params: { uploadType: "multipart", newRevision: false, fields: FILE_FIELDS },
            headers: {
                "Content-Type": `multipart/mixed; boundary="${boundary}"`,
            },
            body: multipartRequestBody,
        });
    }

    async create(fdc, name) {
        console.log(`Google Drive: creating disc image: '${name}'`);
        const byteSize = utils.discImageSize(name).byteSize;
        const data = new Uint8Array(byteSize);
        utils.setDiscName(data, name);
        const response = await this.saveFile(name, data);
        const meta = response.result;
        return { fileId: meta.id, disc: this.makeDisc(fdc, data, meta) };
    }

    makeDisc(fdc, data, meta) {
        let flusher = null;
        const name = meta.name;
        const id = meta.id;
        if (meta.capabilities.canEdit) {
            console.log("Making editable disc");
            flusher = _.debounce(async (changedData) => {
                console.log("Data changed...");
                await this.saveFile(name, changedData, id);
                console.log("Saved ok");
            }, 200);
        } else {
            console.log("Making read-only disc");
        }
        return discFor(fdc, name, data, flusher);
    }

    async load(fdc, fileId) {
        const meta = (await this.gapi.client.drive.files.get({ fileId: fileId, fields: FILE_FIELDS })).result;
        const data = (await this.gapi.client.drive.files.get({ fileId: fileId, alt: "media" })).body;
        return this.makeDisc(fdc, data, meta);
    }
}
