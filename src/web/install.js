import { toast } from "./toast.js";

const WorkerUrl = "service-worker.js";
const SkipWaiting = "SKIP_WAITING";

/**
 * Register the service worker that makes the page installable and usable offline. A new version waits until the
 * user asks for it, because switching worker reloads the page and that would throw away a running machine.
 */
export function registerServiceWorker(page, { benchmark }) {
    const { navigator, location } = page;
    if (benchmark || !import.meta.env.PROD || !("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol))
        return;

    let offered = false;
    const offerUpdate = (registration) => {
        if (offered) return;
        offered = true;
        toast("A new version of jsbeeb is ready.", {
            title: "Update",
            action: {
                label: "Reload",
                run: () => {
                    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
                    registration.waiting.postMessage({ type: SkipWaiting });
                },
            },
        });
    };

    navigator.serviceWorker
        .register(WorkerUrl)
        .then((registration) => {
            // The first install has no controller yet, and that is not an update.
            const updateIsWaiting = () => !!navigator.serviceWorker.controller && !!registration.waiting;
            if (updateIsWaiting()) offerUpdate(registration);
            registration.addEventListener("updatefound", () =>
                registration.installing.addEventListener("statechange", () => {
                    if (updateIsWaiting()) offerUpdate(registration);
                }),
            );
            // An installed window never navigates, so it would not otherwise look for a new version.
            page.document.addEventListener("visibilitychange", () => {
                if (page.document.visibilityState === "visible") registration.update().catch(() => {});
            });
        })
        .catch((error) => console.error("Service worker registration failed:", error));
}
