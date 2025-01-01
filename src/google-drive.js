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
const delimiter = `\r\n--${boundary}\r\n`;
const close_delim = `\r\n--${boundary}--`;

export class GoogleDriveLoader {
    constructor() {
        this.gapi = null;
        this.authorized = false;
        this.parentFolderId = undefined;
    }

    async initialise() {
        console.log("Creating GAPI");
        this.gapi = await this._loadScript("https://apis.google.com/js/api.js", () => window.gapi);
        console.log("Got GAPI, creating token client");
        this.tokenClient = await this._loadScript("https://accounts.google.com/gsi/client", () => {
            return window.google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                error_callback: "", // defined later
                callback: "", // defined later
            });
        });
        console.log("Token client created, loading client");

        await this.gapi.load("client", async () => {
            console.log("Client loaded; initialising GAPI");
            await this.gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] });
            console.log("GAPI initialised");
        });
        console.log("Google Drive: available");
        return true;
    }

    _loadScript(src, onload) {
        return new Promise((resolve) => {
            const script = document.createElement("script");
            script.src = src;
            script.onload = () => resolve(onload());
            document.body.appendChild(script);
        });
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
        let response = await this.gapi.client.drive.files.list({ q: `mimeType = '${MIME_TYPE}'` });
        let result = response.result.files;
        while (response.result.nextPageToken) {
            response = await this.gapi.client.drive.files.list({ pageToken: response.result.nextPageToken });
            result = result.concat(response.result.files);
        }
        return result;
    }

    async _findOrCreateParentFolder() {
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
            resource: { name: PARENT_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
            fields: "id",
        });
        console.log("Folder Id:", file.result.id);
        return file.result.id;
    }

    async saveFile(name, data, idOrNone) {
        if (this.parentFolderId === undefined) {
            this.parentFolderId = await this._findOrCreateParentFolder();
        }
        const metadata = { name, mimeType: MIME_TYPE };
        if (!idOrNone) metadata.parents = [this.parentFolderId];

        const base64Data = btoa(utils.uint8ArrayToString(data));
        const multipartRequestBody = `${delimiter}Content-Type: application/json\r\n\r\n${JSON.stringify(metadata)}${delimiter}Content-Type: ${MIME_TYPE}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Data}${close_delim}`;

        return this.gapi.client.request({
            path: `/upload/drive/v3/files${idOrNone ? `/${idOrNone}` : ""}`,
            method: idOrNone ? "PATCH" : "POST",
            params: { uploadType: "multipart", newRevision: false, fields: FILE_FIELDS },
            headers: { "Content-Type": `multipart/mixed; boundary="${boundary}"` },
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
        const meta = (await this.gapi.client.drive.files.get({ fileId, fields: FILE_FIELDS })).result;
        const data = (await this.gapi.client.drive.files.get({ fileId, alt: "media" })).body;
        return this.makeDisc(fdc, data, meta);
    }
}
