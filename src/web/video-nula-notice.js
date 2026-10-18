import { noteFeature } from "./analytics.js";
import { toast } from "./toast.js";

export const VideoNulaFeature = "videonula";

/**
 * Tells the user the program wrote to a VideoNuLA the machine has not got, and offers to fit one, which restarts the
 * emulator. In a shared session fitting one would end the session, so it only says so.
 * @param {{inSession: boolean, fit: function(): void}} options
 */
export function offerVideoNula({ inSession, fit }) {
    noteFeature(VideoNulaFeature, "missing");
    const missing = "This program tried to use a VideoNuLA, which isn't fitted.";
    toast(inSession ? `${missing} One can be fitted once the shared session is over.` : missing, {
        title: "VideoNuLA",
        quietKey: "quietVideoNulaMissing",
        action: inSession ? null : { label: "Fit one", run: fit },
    });
}
