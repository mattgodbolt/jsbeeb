import { downloadDriveData } from "../dom-utils.js";

const UnloadWarning =
    "It seems like you're still using the emulator. If you're in Chrome, it's impossible for jsbeeb to prevent some shortcuts (like ctrl-W) from performing their default behaviour (e.g. closing the window).\n" +
    "As a workarond, create an 'Application Shortcut' from the Tools menu.  When jsbeeb runs as an application, it *can* prevent ctrl-W from closing the window.";

/**
 * The page around the emulator: the reset menu items and the filestore
 * download, what focus and unload do to the machine, the drop guard, the
 * dialogs a URL can ask for, and the version stamp.
 */
export class PageActions {
    constructor({ loop, processor, keyboard, audioHandler, rewindUI, modals, parsedQuery, version }) {
        this.processor = processor;
        this.rewindUI = rewindUI;

        for (const el of document.querySelectorAll(".initially-hidden")) el.classList.remove("initially-hidden");
        document.getElementById("paste-form").addEventListener("submit", (event) => event.preventDefault());

        window.addEventListener("blur", () => {
            keyboard.clearKeys();
            loop.setEmulationLead(audioHandler.setWindowFocused(false));
        });
        window.addEventListener("focus", () => loop.setEmulationLead(audioHandler.setWindowFocused(true)));

        // To lower the chance of data loss, only the drop zone in the menu bar accepts drops.
        document.addEventListener("dragover", (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "none";
        });
        document.addEventListener("drop", (event) => event.preventDefault());

        window.addEventListener("beforeunload", (event) => {
            if (!loop.isRunning() || !processor.sysvia.hasAnyKeyDown()) return;
            event.preventDefault();
            event.returnValue = UnloadWarning;
        });

        document.getElementById("hard-reset").addEventListener("click", (event) => {
            event.preventDefault();
            this.hardReset();
        });
        document.getElementById("soft-reset").addEventListener("click", (event) => {
            event.preventDefault();
            this.softReset();
        });
        document.getElementById("download-filestore-link").addEventListener("click", () => this.downloadFilestore());

        if (Object.hasOwn(parsedQuery, "about")) modals.show("info");
        if (Object.hasOwn(parsedQuery, "pp-tos")) modals.show("pp-tos");

        const versionElement = document.getElementById("jsbeeb-version");
        if (versionElement) versionElement.textContent = `Version ${version}`;
    }

    hardReset() {
        this.rewindUI.reset();
        this.processor.reset(true);
    }

    softReset() {
        this.processor.reset(false);
    }

    downloadFilestore() {
        if (!this.processor.filestore) return;
        downloadDriveData(this.processor.filestore.scsi, "scsi", ".dat");
    }
}
