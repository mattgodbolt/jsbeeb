// The way into a shared session from the top bar: a dialog to host on the machine as it is, or to join
// someone else's room, and once a session is going, its pane.

import * as bootstrap from "bootstrap";

import { roomFrom } from "./shared-session.js";

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

        opener.addEventListener("click", (event) => {
            event.preventDefault();
            if (this.session) this.session.panel.open();
            else bootstrap.Modal.getOrCreateInstance(dialog).show();
        });
        hostButton.addEventListener("click", async () => {
            bootstrap.Modal.getOrCreateInstance(dialog).hide();
            this.session = await host(nameInput.value);
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
