import * as bootstrap from "bootstrap";
import { noteFeature } from "./analytics.js";

/**
 * The dialogs the page raises itself, and the rule that a dialog pauses the
 * emulator: the first one up stops it, and the last one down starts it again
 * if it was running before.
 */
export class Modals {
    constructor({ loop }) {
        this.errorDialog = document.getElementById("error-dialog");
        this.errorModal = new bootstrap.Modal(this.errorDialog);
        this.aysEl = document.getElementById("are-you-sure");
        this.aysModal = new bootstrap.Modal(this.aysEl);

        // Bootstrap lets a modal show again once its dialog has faded but before its backdrop has, and the late hidden
        // event then takes the reopened modal's backdrop and its hold on the emulator; so a show in that gap waits.
        const reopenWhenHidden = new WeakMap();
        document.addEventListener(
            "show.bs.modal",
            (event) => {
                if (!reopenWhenHidden.has(event.target)) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                reopenWhenHidden.set(event.target, true);
            },
            { capture: true },
        );
        document.addEventListener("hide.bs.modal", (event) => {
            if (!event.defaultPrevented) reopenWhenHidden.set(event.target, false);
        });

        const holds = new WeakMap();
        document.addEventListener("show.bs.modal", (event) => {
            noteFeature(event.target, "open");
            if (!holds.has(event.target)) holds.set(event.target, loop.hold(`the ${event.target.id} dialog`));
        });
        document.addEventListener("hidden.bs.modal", (event) => {
            const reopen = reopenWhenHidden.get(event.target);
            reopenWhenHidden.delete(event.target);
            holds.get(event.target)?.();
            holds.delete(event.target);
            if (reopen) bootstrap.Modal.getOrCreateInstance(event.target).show();
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
