import * as bootstrap from "bootstrap";
import { toast } from "./toast.js";

/**
 * The dialogs the page raises itself, and the rule that a dialog pauses the
 * emulator: the first one up stops it, and the last one down starts it again
 * if it was running before.
 */
export class Modals {
    constructor({ isRunning, stop, go }) {
        this.errorDialog = document.getElementById("error-dialog");
        this.errorModal = new bootstrap.Modal(this.errorDialog);
        this.loadingDialog = document.getElementById("loading-dialog");
        this.loadingModal = new bootstrap.Modal(this.loadingDialog);
        this.googleDriveAuth = document.getElementById("google-drive-auth");
        this.aysEl = document.getElementById("are-you-sure");
        this.aysModal = new bootstrap.Modal(this.aysEl);

        let savedRunning = false;
        document.addEventListener("show.bs.modal", () => {
            if (!this.anyVisible()) savedRunning = isRunning();
            if (isRunning()) stop(false);
        });
        document.addEventListener("hidden.bs.modal", () => {
            if (!this.anyVisible() && savedRunning) go();
        });
    }

    anyVisible() {
        return document.querySelectorAll(".modal.show").length !== 0;
    }

    show(id) {
        const el = document.getElementById(id);
        if (el) bootstrap.Modal.getOrCreateInstance(el).show();
    }

    hide(id) {
        bootstrap.Modal.getInstance(document.getElementById(id))?.hide();
    }

    showError(context, error) {
        this.errorDialog.querySelector(".context").textContent = context;
        this.errorDialog.querySelector(".error").textContent = error;
        this.errorModal.show();
    }

    popupLoading(msg) {
        this.loadingDialog.querySelector(".loading").textContent = msg;
        this.googleDriveAuth.style.display = "none";
        this.loadingModal.show();
    }

    loadingFinished(message) {
        this.googleDriveAuth.style.display = "none";
        this.loadingModal.hide();
        if (message) toast(message);
    }

    areYouSure(message, yesText, noText, yesFunc) {
        const yesButton = this.aysEl.querySelector(".ays-yes");
        this.aysEl.querySelector(".context").textContent = message;
        this.aysEl.querySelector(".ays-no").textContent = noText;
        yesButton.textContent = yesText;
        let confirmed = false;
        const onYes = () => {
            confirmed = true;
            this.aysModal.hide();
        };
        yesButton.addEventListener("click", onYes, { once: true });
        // The "no" button, Escape and a click outside raise no event of their own: they only hide the modal.
        this.aysEl.addEventListener(
            "hidden.bs.modal",
            () => {
                yesButton.removeEventListener("click", onYes);
                if (confirmed) yesFunc();
            },
            { once: true },
        );
        this.aysModal.show();
    }
}
