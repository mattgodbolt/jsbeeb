import * as bootstrap from "bootstrap";
import { toast } from "./toast.js";

/**
 * The dialogs the page raises itself, and the rule that a dialog pauses the
 * emulator: the first one up stops it, and the last one down starts it again
 * if it was running before.
 */
export class Modals {
    constructor({ loop }) {
        this.errorDialog = document.getElementById("error-dialog");
        this.errorModal = new bootstrap.Modal(this.errorDialog);
        this.loadingDialog = document.getElementById("loading-dialog");
        this.loadingModal = new bootstrap.Modal(this.loadingDialog);
        this.aysEl = document.getElementById("are-you-sure");
        this.aysModal = new bootstrap.Modal(this.aysEl);

        const holds = new WeakMap();
        document.addEventListener("show.bs.modal", (event) => {
            if (!holds.has(event.target)) holds.set(event.target, loop.pause(`the ${event.target.id} dialog`));
        });
        document.addEventListener("hidden.bs.modal", (event) => {
            holds.get(event.target)?.();
            holds.delete(event.target);
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
        const el = document.getElementById(id);
        if (el) bootstrap.Modal.getInstance(el)?.hide();
    }

    showError(context, error) {
        this.errorDialog.querySelector(".context").textContent = context;
        this.errorDialog.querySelector(".error").textContent = error;
        this.errorModal.show();
    }

    popupLoading(msg) {
        this.loadingDialog.querySelector(".loading").textContent = msg;
        this.loadingModal.show();
    }

    loadingFinished(message) {
        this.loadingModal.hide();
        if (message) toast(message);
    }

    /** @returns {Promise<boolean>} true for the yes button; false for any other way out of the dialog */
    confirm(message, yesText, noText) {
        const yesButton = this.aysEl.querySelector(".ays-yes");
        this.aysEl.querySelector(".context").textContent = message;
        this.aysEl.querySelector(".ays-no").textContent = noText;
        yesButton.textContent = yesText;
        return new Promise((resolve) => {
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
                    resolve(confirmed);
                },
                { once: true },
            );
            this.aysModal.show();
        });
    }
}
