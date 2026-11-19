import { pathToFileURL } from "node:url";

/** @returns {boolean} whether an IPC message came from the app's own page, and not from what the window has gone on to show */
export function isAppPage(event, appPagePath) {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender?.mainFrame) return false;
    try {
        const url = new URL(frame.url);
        return url.protocol === "file:" && url.host === "" && url.pathname === pathToFileURL(appPagePath).pathname;
    } catch {
        return false;
    }
}
