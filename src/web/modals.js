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

        // Bootstrap raises a modal's hidden event only once its backdrop has faded, and that late event clears
        // body.modal-open (and, here, the modal's hold) whatever has opened since; so a show waits for it.
        const closing = new Set();
        const waiting = new Set();
        const closed = (modal) => {
            closing.delete(modal);
            if (closing.size !== 0) return;
            const shows = [...waiting];
            waiting.clear();
            for (const waited of shows) bootstrap.Modal.getOrCreateInstance(waited).show();
        };
        document.addEventListener(
            "show.bs.modal",
            (event) => {
                if (closing.size === 0) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                waiting.add(event.target);
            },
            { capture: true },
        );
        document.addEventListener("hide.bs.modal", (event) => closing.add(event.target), { capture: true });
        document.addEventListener("hide.bs.modal", (event) => {
            if (event.defaultPrevented) closed(event.target);
        });

        const holds = new WeakMap();
        document.addEventListener("show.bs.modal", (event) => {
            noteFeature(event.target, "open");
            if (!holds.has(event.target)) holds.set(event.target, loop.hold(`the ${event.target.id} dialog`));
        });
        document.addEventListener("hidden.bs.modal", (event) => {
            holds.get(event.target)?.();
            holds.delete(event.target);
            closed(event.target);
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
        return new Promise((resolve) => {
            let confirmed = false;
            const onYes = () => {
                confirmed = true;
                this.aysModal.hide();
            };
            // The "no" button, Escape and a click outside raise no event of their own: they only hide the modal.
            const onHidden = () => {
                yesButton.removeEventListener("click", onYes);
                resolve(confirmed);
            };
            // Asked from the show, not now, so a previous opening's late hidden cannot answer this question.
            const ask = () => {
                this.aysEl.querySelector(".context").textContent = message;
                this.aysEl.querySelector(".ays-no").textContent = noText;
                yesButton.textContent = yesText;
                yesButton.addEventListener("click", onYes, { once: true });
                this.aysEl.addEventListener("hidden.bs.modal", onHidden, { once: true });
            };
            this.aysEl.addEventListener("show.bs.modal", ask, { once: true });
            // Bootstrap raises no show at all while the dialog is up or in its own fade; that question goes unasked.
            let raised = false;
            const onRaised = (event) => (raised ||= event.target === this.aysEl);
            window.addEventListener("show.bs.modal", onRaised, { capture: true });
            this.aysModal.show();
            window.removeEventListener("show.bs.modal", onRaised, { capture: true });
            if (!raised) {
                this.aysEl.removeEventListener("show.bs.modal", ask);
                resolve(false);
            }
        });
    }
}
