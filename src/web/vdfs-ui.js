// The page's side of a folder served as VDFS in a browser: what to do when the browser has to be asked again, and the
// menu to choose the folder with. The desktop app has its own, in src/app/electron.js.

import { chooseFolder, forgetFolder } from "./vdfs-folder.js";
import { reloadAsMachine } from "./machine-switch.js";

/**
 * Has the page hand its open files to the folder when it is going away, say through `notify` when the folder cannot be
 * written, and offer through `offer` to ask the browser again if it has to be asked, which only a click can do.
 */
export async function attachBrowserVdfs(host, { notify, offer }) {
    const flush = () => host.flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
    });
    host.onWriteFailure = (error) =>
        notify(`The VDFS folder could not be updated (${error.message}). What the BBC wrote may be lost.`);
    const state = await host.store.permission();
    if (state === "none") notify("No folder has been chosen to serve as VDFS. Choose one from the More menu.");
    else if (state !== "granted")
        offer("The browser needs to be told again that the VDFS folder may be used.", "Allow", async () => {
            const answer = await host.store.requestPermission();
            if (answer !== "granted") notify("The browser did not allow the VDFS folder to be used.");
        });
}

/** Serving a folder starts the machine again with it, so the menu asks first if something is running. */
export function attachVdfsMenu({ urlState, modals, serving }) {
    const serve = document.getElementById("vdfs-serve");
    const stop = document.getElementById("vdfs-stop");
    serve.hidden = false;
    stop.hidden = !serving;

    const restartWith = async (params, message) => {
        if (!(await modals.confirm(message, "Restart", "Cancel"))) return false;
        reloadAsMachine(urlState, params);
        return true;
    };

    serve.addEventListener("click", async (event) => {
        event.preventDefault();
        let handle;
        try {
            handle = await chooseFolder();
        } catch (error) {
            if (error.name === "AbortError") return;
            throw error;
        }
        const message = `Serve "${handle.name}" as VDFS? The BBC restarts, and then *VDFS selects it.`;
        if (!(await restartWith({ vdfs: true }, message))) await forgetFolder();
    });
    stop.addEventListener("click", async (event) => {
        event.preventDefault();
        if (await restartWith({ vdfs: undefined }, "Stop serving the VDFS folder? The BBC restarts."))
            await forgetFolder();
    });
}
