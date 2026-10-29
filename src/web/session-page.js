// What a shared session shows and hears of the page it runs on: notices, the lights and pane, whether the page can
// be seen, and its going.

import { joinLink } from "./shared-session.js";
import { reloadAsMachine } from "./machine-switch.js";
import { watchPage } from "./session-log.js";
import { SessionPanel } from "./session-panel.js";
import { downloadBlob } from "./dom-utils.js";
import { toast } from "./toast.js";

const ToastTitle = "Shared session";

function notify(message) {
    console.log(`Shared session: ${message}`);
    toast(message, { title: ToastTitle });
}

async function copyJoinLink(room) {
    if (!navigator.clipboard) {
        notify(`Copying needs https. Guests join at ${joinLink(room)}`);
        return;
    }
    try {
        await navigator.clipboard.writeText(joinLink(room));
        toast("The link to join is on the clipboard.", { title: ToastTitle });
    } catch (error) {
        notify(`Couldn't copy the link (${error.message}). Guests join at ${joinLink(room)}`);
    }
}

function saveReport(session) {
    const report = session.report();
    const stamp = report.savedAt.replace(/[:.]/g, "-");
    const blob = new Blob([JSON.stringify(report)], { type: "application/json" });
    downloadBlob(blob, `jsbeeb-session-${report.role}-${stamp}.json`);
}

/**
 * @typedef {object} SessionPage
 * @property {function(string): void} notify tells this person something
 * @property {function(): boolean} hidden whether the page is out of sight, as a hidden tab runs slowly
 * @property {typeof watchPage} watch
 * @property {function(function(): void, AbortSignal): void} onPageHide calls back as the page goes, until `signal`
 * @property {function(string): string} joinLink the address a guest joins a room at
 * @property {function(object): void} reloadAs reloads the page, in place, as the machine these parameters make
 * @property {function(object, function(boolean): void=): SessionPanel} panel the lights and pane for a session, with
 * the host's setter for whether a key press takes control
 */

/**
 * @param {import("./url-state.js").UrlState} urlState
 * @param {import("./floating-panel.js").PanelArrangement} arrangement what places the session's pane
 * @returns {SessionPage}
 */
export function sessionPage(urlState, arrangement) {
    return {
        notify,
        hidden: () => document.hidden,
        watch: watchPage,
        onPageHide: (listener, signal) => window.addEventListener("pagehide", listener, { signal }),
        joinLink: (room) => joinLink(room),
        reloadAs: (params) => reloadAsMachine(urlState, params, { replace: true }),
        panel: (session, setTakeOnKey) =>
            new SessionPanel({
                name: session.name,
                link: joinLink(session.room),
                saveReport: () => saveReport(session),
                copyLink: () => copyJoinLink(session.room),
                requestControl: () => session.requestControl(null),
                setTakeOnKey,
                arrangement,
            }),
    };
}
