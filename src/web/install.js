import { toast } from "./toast.js";

const WorkerUrl = "service-worker.js";
const SkipWaiting = "SKIP_WAITING";
const WhichBuild = "WHICH_BUILD";

function buildOf(worker) {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
            channel.port1.close();
            resolve(data);
        };
        worker.postMessage({ type: WhichBuild }, [channel.port2]);
    });
}

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
                    // Another tab may already have switched over, leaving nothing to wait for.
                    if (!registration.waiting) return location.reload();
                    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), {
                        once: true,
                    });
                    registration.waiting.postMessage({ type: SkipWaiting });
                },
            },
        });
    };

    navigator.serviceWorker
        .register(WorkerUrl)
        .then((registration) => {
            // The first install has no controller yet, and that is not an update. The page itself comes from the
            // network, so a worker that installed as it loaded is usually the build already running.
            const offerIfNewer = async () => {
                const { waiting } = registration;
                if (!navigator.serviceWorker.controller || !waiting) return;
                if ((await buildOf(waiting)) !== import.meta.env.JSBEEB_COMMIT) offerUpdate(registration);
            };
            offerIfNewer();
            registration.addEventListener("updatefound", () =>
                registration.installing.addEventListener("statechange", offerIfNewer),
            );
            // An installed window never navigates, so it would not otherwise look for a new version.
            page.document.addEventListener("visibilitychange", () => {
                if (page.document.visibilityState === "visible") registration.update().catch(() => {});
            });
        })
        .catch((error) => console.error("Service worker registration failed:", error));
}
