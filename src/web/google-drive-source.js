import * as disc from "../fdc.js";
import { GoogleDriveLoader } from "./google-drive.js";
import { toast } from "./toast.js";
import { errorText } from "./reporting.js";
import { replaceOrAddExtension } from "../archive.js";
import { describeDriveFile } from "./media-catalogue.js";

const isUnauthorised = (error) => error?.status === 401 || error?.result?.error?.code === 401;

/**
 * Google Drive as a media source: signing in, listing the user's discs,
 * loading one, and creating a new one there.
 */
export class GoogleDriveSource {
    constructor({ media, loader = new GoogleDriveLoader() }) {
        this.googleDrive = loader;
        media.addSource("drive", (cat, layout) => this.load(cat, layout));
        media.addLister("gdrive", async () =>
            this.connected ? (await this.withToken(() => this.googleDrive.listFiles())).map(describeDriveFile) : [],
        );
    }

    /** Runs a Drive call; a 401 means the token has lapsed, so the account is connected no longer. */
    async withToken(call) {
        try {
            return await call();
        } catch (error) {
            if (isUnauthorised(error)) this.googleDrive.authorized = false;
            throw error;
        }
    }

    get connected() {
        return !!this.googleDrive.authorized;
    }

    /** Loads the Google client and signs in; false when either is refused. Needs a user gesture. */
    async connect() {
        try {
            await this.googleDrive.initialise();
        } catch (error) {
            toast(`Google Drive is unavailable: ${errorText(error)}`, { title: "Google Drive" });
            return false;
        }
        try {
            return await this.googleDrive.authorize(false);
        } catch (error) {
            toast(`There was an error accessing your Google Drive account: ${errorText(error)}`, {
                title: "Google Drive",
            });
            return false;
        }
    }

    /**
     * A disc from the Drive, once signed in. Signing in needs a click, so a
     * load from elsewhere (the URL at startup, say) can only ask for one.
     */
    async load(cat, layout) {
        if (!(await this.googleDrive.initialise())) throw new Error("Google Drive is not available");
        if (!(await this.googleDrive.authorize(true)))
            throw new Error("Google Drive is not connected; use Connect Google Drive in the media window first");
        const loaded = await this.withToken(() => this.googleDrive.load(cat.id, layout));
        if (!loaded.savesChanges) {
            toast(`${cat.name} is read only on Google Drive, so changes to it are not written back.`, {
                title: "Google Drive",
                quietKey: "quietDriveReadOnly",
            });
        }
        return loaded;
    }

    /**
     * Makes a blank, formatted disc on the Drive.
     *
     * @returns {Promise<{ref: string, disc: import("../disc.js").Disc}>} the disc, and how the URL names it
     */
    async createBlank(name, layout) {
        // TODO(#1070) blank HFE images have no fixed byteSize, so only SSD and DSD blanks can be made here.
        const discType = disc.guessDiscTypeFromName(name);
        if (!discType.byteSize) throw new Error(`blank ${discType.extension} discs have no known size`);
        const data = new Uint8Array(discType.byteSize);
        if (discType.supportsCatalogue) discType.setDiscName(data, name);
        return this.createFrom(name, data, layout);
    }

    /** Puts an image on the Drive under `name`, as a disc that saves its changes there. */
    async createFrom(name, data, layout) {
        const fullName = replaceOrAddExtension(name, disc.guessDiscTypeFromName(name).extension);
        const result = await this.withToken(() => this.googleDrive.create(fullName, data, layout));
        return { ref: `gd:${result.fileId}/${fullName}`, disc: result.disc };
    }
}
