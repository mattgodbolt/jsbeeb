// The way into a shared session from the More menu: a dialog to host on the machine as it is, or to join
// someone else's room, and once a session is going, its pane.

import * as bootstrap from "bootstrap";

import { roomFrom } from "./shared-session.js";

// An Enter held on Start hosting repeats after the dialog has gone, and the machine, which never saw it go down,
// would take each repeat as a fresh RETURN.
function holdBackEnterRepeats() {
    const done = new AbortController();
    const options = { capture: true, signal: done.signal };
    window.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Enter" || !event.repeat) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        },
        options,
    );
    window.addEventListener("keyup", (event) => event.key === "Enter" && done.abort(), options);
}

export class SessionDialog {
    /**
     * @param {object} options
     * @param {{panel: import("./session-panel.js").SessionPanel}|null} options.session the page's session, if any
     * @param {string|null} options.refusal why this machine cannot take part in a session, if it cannot
     * @param {function(string): Promise<object|null>} options.host hosts as the given name, resolving to the session,
     * or null if there is none
     * @param {function(string, string): void} options.join joins the given room as the given name
     */
    constructor(
        { session, refusal, host, join },
        opener = document.getElementById("session-open"),
        dialog = document.getElementById("session-dialog"),
    ) {
        this.session = session;
        const nameInput = dialog.querySelector(".session-name");
        const roomInput = dialog.querySelector(".session-room");
        const hostButton = dialog.querySelector(".session-host");
        const joinButton = dialog.querySelector(".session-join");
        const refusalText = dialog.querySelector(".session-refusal");
        refusalText.textContent = refusal ?? "";
        refusalText.hidden = !refusal;
        hostButton.disabled = joinButton.disabled = !!refusal;

        this.hosting = false;
        // Bootstrap ignores a hide while the dialog is still fading in, which would leave hosting waiting for
        // whatever closed it later.
        let shown = false;
        dialog.addEventListener("shown.bs.modal", () => (shown = true));
        dialog.addEventListener("hide.bs.modal", () => (shown = false));

        opener.addEventListener("click", (event) => {
            event.preventDefault();
            if (this.session) this.session.panel.open();
            else if (!this.hosting) bootstrap.Modal.getOrCreateInstance(dialog).show();
        });
        // Hosting waits for the dialog to go, and for every other listener to its going (the page's hold on the
        // machine among them) to have run, so the machine is no longer held for it.
        hostButton.addEventListener("click", (event) => {
            if (!shown) return;
            this.hosting = true;
            hostButton.disabled = joinButton.disabled = true;
            if (event.detail === 0) holdBackEnterRepeats();
            dialog.addEventListener(
                "hidden.bs.modal",
                async () => {
                    await new Promise((resolve) => setTimeout(resolve));
                    this.session = await host(nameInput.value);
                    this.hosting = false;
                    if (!this.session) hostButton.disabled = joinButton.disabled = false;
                },
                { once: true },
            );
            bootstrap.Modal.getOrCreateInstance(dialog).hide();
        });
        roomInput.addEventListener("input", () => roomInput.classList.remove("is-invalid"));
        dialog.querySelector(".session-join-form").addEventListener("submit", (event) => {
            event.preventDefault();
            const room = roomFrom(roomInput.value);
            roomInput.classList.toggle("is-invalid", !room);
            if (room) join(room, nameInput.value.trim());
        });
    }
}
