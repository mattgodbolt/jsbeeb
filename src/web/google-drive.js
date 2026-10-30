import { discFor } from "../fdc.js";
import { uint8ArrayToString } from "../binary.js";
import { debounce } from "../debounce.js";

const MIME_TYPE = "application/vnd.jsbeeb.disc-image";
const CLIENT_ID = "356883185894-bhim19837nroivv18p0j25gecora60r5.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
const FILE_FIELDS = "id,name,capabilities";
const PARENT_FOLDER_NAME = "jsbeeb disc images";

const boundary = "-------314159265358979323846";
const delimiter = `\r\n--${boundary}\r\n`;
const close_delim = `\r\n--${boundary}--`;

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export class GoogleDriveLoader {
    constructor() {
        this.authorized = false;
        this.parentFolderId = undefined;
        this.driveClient = undefined;
    }

    initialise() {
        if (!this._initialising) {
            this._initialising = this._initialise().catch((error) => {
                this._initialising = undefined;
                throw error;
            });
        }
        return this._initialising;
    }

    async _initialise() {
        await this._loadScript("https://apis.google.com/js/api.js");
        this.gapi = window.gapi;
        await this._loadScript("https://accounts.google.com/gsi/client");
        this.tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            error_callback: "", // defined later
            callback: "", // defined later
        });

        await this.gapi.load("client", async () => {
            await this.gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] });
            this.driveClient = this.gapi.client.drive;
        });
        return true;
    }

    _loadScript(src) {
        // https://github.com/google/google-api-javascript-client/issues/319
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to fetch ${src}; a browser extension may be blocking it`));
            document.body.appendChild(script);
        });
    }

    authorize(imm) {
        if (this.authorized) return true;
        if (imm) return false;
        return new Promise((resolve, reject) => {
            this.tokenClient.callback = (resp) => {
                if (resp.error !== undefined) return reject(new Error(resp.error_description ?? resp.error));
                this.authorized = true;
                resolve(true);
            };
            this.tokenClient.error_callback = (resp) => {
                reject(new Error(`Token client failure: ${resp.type}; failed to authorize`));
            };
            this.tokenClient.requestAccessToken({ select_account: false });
        });
    }

    async listFiles() {
        const query = {
            q: `mimeType = '${MIME_TYPE}' and trashed = false`,
            fields: `nextPageToken, files(${FILE_FIELDS})`,
        };
        let response = await this.driveClient.files.list(query);
        let result = response.result.files;
        while (response.result.nextPageToken) {
            response = await this.driveClient.files.list({ ...query, pageToken: response.result.nextPageToken });
            result = result.concat(response.result.files);
        }
        return result;
    }

    async _findOrCreateParentFolder() {
        const list = await this.driveClient.files.list({
            q: `name = '${PARENT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
            corpora: "user",
        });
        if (list.result.files.length === 1) {
            return list.result.files[0].id;
        }
        const file = await this.driveClient.files.create({
            resource: { name: PARENT_FOLDER_NAME, mimeType: FOLDER_MIME_TYPE },
            fields: "id",
        });
        return file.result.id;
    }

    async saveFile(name, data, idOrNone) {
        if (this.parentFolderId === undefined) {
            this.parentFolderId = await this._findOrCreateParentFolder();
        }
        const metadata = { name, mimeType: MIME_TYPE };
        if (!idOrNone) metadata.parents = [this.parentFolderId];

        const base64Data = btoa(uint8ArrayToString(data));
        const multipartRequestBody =
            `${delimiter}Content-Type: application/json\r\n\r\n` +
            `${JSON.stringify(metadata)}${delimiter}` +
            `Content-Type: ${MIME_TYPE}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
            `${base64Data}${close_delim}`;

        return this.gapi.client.request({
            path: `/upload/drive/v3/files${idOrNone ? `/${idOrNone}` : ""}`,
            method: idOrNone ? "PATCH" : "POST",
            params: { uploadType: "multipart", newRevision: false, fields: FILE_FIELDS },
            headers: { "Content-Type": `multipart/mixed; boundary="${boundary}"` },
            body: multipartRequestBody,
        });
    }

    /**
     * @param {function(Error): void} onSaveError - called the first time a change cannot be saved
     */
    async create(name, data, layout, onSaveError) {
        const response = await this.saveFile(name, data);
        const meta = response.result;
        return { fileId: meta.id, disc: this.makeDisc(data, meta, layout, onSaveError) };
    }

    makeDisc(data, meta, layout, onSaveError) {
        let flusher = null;
        const name = meta.name;
        const id = meta.id;
        if (meta.capabilities.canEdit) {
            let reportedSaveError = false;
            flusher = debounce(async (changedData) => {
                try {
                    await this.saveFile(name, changedData, id);
                } catch (error) {
                    if (reportedSaveError) return;
                    reportedSaveError = true;
                    // The Drive client rejects with its response, not an Error.
                    onSaveError(
                        error instanceof Error
                            ? error
                            : new Error(error?.result?.error?.message ?? "the request to Google Drive failed"),
                    );
                }
            }, 200);
        }
        return discFor(name, data, flusher, layout);
    }

    /**
     * @param {function(Error): void} onSaveError - called the first time a change cannot be saved
     */
    async load(fileId, layout, onSaveError) {
        const meta = (await this.driveClient.files.get({ fileId, fields: FILE_FIELDS })).result;
        const data = (await this.driveClient.files.get({ fileId, alt: "media" })).body;
        return this.makeDisc(data, meta, layout, onSaveError);
    }
}
