import { runningInNode } from "../loader.js";

export function noteEvent(category, type, label) {
    if (
        !runningInNode &&
        (window.location.host.endsWith(".godbolt.org") || window.location.host.endsWith(".xania.org"))
    ) {
        // Only note events on the public site
        /*global gtag*/
        gtag("event", category, { type, label });
    }
    console.log("event noted:", category, type, label);
}
