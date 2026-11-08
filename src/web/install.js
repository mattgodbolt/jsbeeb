import { Workbox } from "workbox-window";
import { toast } from "./toast.js";

/**
 * Register the service worker that makes the page installable and usable offline. A new version waits
 * until the user asks for it, because switching worker reloads the page and that would throw away a
 * running machine.
 */
export function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !/^https?:$/.test(window.location.protocol)) return;
    const worker = new Workbox("service-worker.js");
    worker.addEventListener("waiting", () => {
        toast("A new version of jsbeeb is ready.", {
            title: "Update",
            action: {
                label: "Reload",
                run: () => {
                    worker.addEventListener("controlling", () => window.location.reload());
                    worker.messageSkipWaiting();
                },
            },
        });
    });
    worker.register().catch((error) => console.error("Service worker registration failed:", error));
}
