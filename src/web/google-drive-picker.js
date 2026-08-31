import * as utils from "../utils.js";
import * as bootstrap from "bootstrap";
import * as disc from "../fdc.js";
import { GoogleDriveLoader } from "../google-drive.js";
import { toast } from "./toast.js";
import { errorText } from "./reporting.js";

/**
 * The Google Drive picker: signing in, listing the user's discs, loading one
 * and creating a new one, blank or from what is in drive 0.
 */
export class GoogleDrivePicker {
    constructor({ media, drives, modals, processor, loader = new GoogleDriveLoader() }) {
        this.media = media;
        this.drives = drives;
        this.modals = modals;
        this.processor = processor;
        this.googleDrive = loader;

        this.authEl = document.getElementById("google-drive-auth");
        this.el = document.getElementById("google-drive");
        this.modal = new bootstrap.Modal(this.el);
        this.authResolve = null;
        this.authReject = null;

        document.querySelector("#google-drive-auth form").addEventListener("submit", async (e) => {
            this.authEl.style.display = "none";
            e.preventDefault();
            const authed = await this.auth(false);
            if (authed) this.authResolve();
            else this.authReject(new Error("Unable to authorize Google Drive"));
        });

        // Loading the Google client holds the main thread for ~100ms, so it waits for
        // someone to ask for Drive.
        document.getElementById("open-drive-link").addEventListener("click", async (e) => {
            e.preventDefault();
            try {
                await this.googleDrive.initialise();
            } catch (error) {
                toast(`Google Drive is unavailable: ${errorText(error)}`, { title: "Google Drive" });
                return;
            }
            const authed = await this.auth(false);
            if (authed) {
                this.modal.show();
            }
        });

        this.el.addEventListener("show.bs.modal", () => this.showList());
        document.querySelector("#google-drive form").addEventListener("submit", (e) => this.create(e));
    }

    async auth(imm) {
        try {
            return await this.googleDrive.authorize(imm);
        } catch (err) {
            console.log("Error handling google auth: " + err);
            this.el.querySelector(".loading").textContent =
                `There was an error accessing your Google Drive account: ${errorText(err)}`;
        }
    }

    async load(cat, layout) {
        this.modals.popupLoading("Loading '" + cat.name + "' from Google Drive");
        try {
            const available = await this.googleDrive.initialise();
            console.log("Google Drive available =", available);
            if (!available) throw new Error("Google Drive is not available");

            const authed = await this.auth(true);
            console.log("Google Drive authed=", authed);

            if (!authed) {
                await new Promise((resolve, reject) => {
                    this.authResolve = resolve;
                    this.authReject = reject;
                    this.authEl.style.display = "";
                });
            }

            const ssd = await this.googleDrive.load(this.processor.fdc, cat.id, layout);
            console.log("Google Drive loading finished");
            this.modals.loadingFinished();
            if (!ssd.savesChanges) {
                toast(`${cat.name} is read only on Google Drive, so changes to it are not written back.`, {
                    title: "Google Drive",
                    quietKey: "quietDriveReadOnly",
                });
            }
            return ssd;
        } catch (error) {
            console.error("Google Drive loading error:", error);
            this.modals.loadingFinished(`Unable to load ${cat.name} from Google Drive: ${errorText(error)}`);
        }
    }

    async showList() {
        const gdLoading = this.el.querySelector(".loading");
        gdLoading.textContent = "Loading...";
        gdLoading.style.display = "";
        for (const el of this.el.querySelectorAll("li:not(.template)")) el.remove();
        let cat;
        try {
            cat = await this.googleDrive.listFiles();
        } catch (error) {
            console.error("Error listing Google Drive files:", error);
            gdLoading.textContent = `Unable to list your Google Drive files: ${errorText(error)}`;
            return;
        }
        const dbList = this.el.querySelector(".list");
        gdLoading.style.display = "none";
        const template = dbList.querySelector(".template");
        for (const item of cat) {
            const row = template.cloneNode(true);
            row.classList.remove("template");
            dbList.appendChild(row);
            row.querySelector(".name").textContent = item.name;
            row.addEventListener("click", async () => {
                utils.noteEvent("google-drive", "click", item.name);
                this.media.setDisc1Image(`gd:${item.id}/${item.name}`);
                this.modal.hide();
                const ssd = await this.load(item, this.drives.layoutForDrive(0));
                if (ssd) this.drives.putDiscIn(0, ssd);
            });
        }
    }

    async create(e) {
        e.preventDefault();
        let name = document.querySelector("#google-drive .disc-name").value;
        if (!name) return;

        this.modals.popupLoading("Connecting to Google Drive");
        this.modal.hide();
        this.modals.popupLoading("Creating '" + name + "' on Google Drive");

        let data;
        if (document.querySelector("#google-drive .create-from-existing").checked) {
            const discType = disc.guessDiscTypeFromName(name);
            try {
                data = discType.saver(this.processor.fdc.drives[0].disc);
            } catch (e) {
                this.modals.loadingFinished(`Unable to create ${name} on Google Drive: ${errorText(e)}`);
                return;
            }
            name = utils.replaceOrAddExtension(name, discType.extension);
            console.log(`Saving existing disc: ${name}`);
        } else {
            // TODO support HFE, I guess?
            const discType = disc.guessDiscTypeFromName(name);
            if (!discType.byteSize) {
                this.modals.loadingFinished(
                    `Unable to create ${name} on Google Drive: blank ${discType.extension} discs have no known size`,
                );
                return;
            }
            data = new Uint8Array(discType.byteSize);
            if (discType.supportsCatalogue) {
                discType.setDiscName(data, name);
            }
            console.log(`Creating blank: ${name}`);
        }

        try {
            const result = await this.googleDrive.create(this.processor.fdc, name, data);
            this.media.setDisc1Image("gd:" + result.fileId + "/" + name);
            this.drives.putDiscIn(0, result.disc);
            this.modals.loadingFinished();
        } catch (error) {
            console.error(`Error creating Google Drive disc: ${error}`, error);
            this.modals.loadingFinished(`Unable to create ${name} on Google Drive: ${errorText(error)}`);
        }
    }
}
