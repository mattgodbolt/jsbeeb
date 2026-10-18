import { noteFeature } from "./analytics.js";
import { toast } from "./toast.js";

export const VideoNulaFeature = "videonula";

const AfterSession = "One can be fitted once the shared session is over.";

/**
 * Tells the user the program wrote to a VideoNuLA the machine has not got, and offers to fit one, which restarts the
 * emulator. In a shared session fitting one would end the session, so it only says so.
 * @param {{inSession: boolean, fit: function(): void}} options
 */
export function offerVideoNula({ inSession, fit }) {
    noteFeature(VideoNulaFeature, "missing");
    const missing = "This program tried to use a VideoNuLA, which isn't fitted.";
    toast(inSession ? `${missing} ${AfterSession}` : missing, {
        title: "VideoNuLA",
        quietKey: "quietVideoNulaMissing",
        action: inSession ? null : { label: "Fit one and restart", run: fit },
    });
}

/**
 * The page's answer to a program writing to the missing VideoNuLA: an offer, made once the emulator has let go, since
 * the write is raised mid-instruction; `inSession()` says whether a shared session is running, and fitting one sets
 * it in `settings`, so the URL records it, and then `restart`s, unless a session has started since the offer was made.
 */
export const answerMissingVideoNula =
    ({ inSession, settings, restart = () => window.location.reload() }) =>
    () =>
        setTimeout(() =>
            offerVideoNula({
                inSession: inSession(),
                fit: () => {
                    if (inSession()) {
                        toast(AfterSession, { title: "VideoNuLA" });
                        return;
                    }
                    settings.set({ hasVideoNula: true });
                    restart();
                },
            }),
        );
