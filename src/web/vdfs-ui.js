// The page's side of a folder served as VDFS in a browser: what to do when the browser has to be asked again, and the
// menu to choose the folder with. The desktop app has its own, in src/app/electron.js.

import { forgetFolder, pickFolder, saveFolder } from "./vdfs-folder.js";
import { reloadAsMachine } from "./machine-switch.js";

export const ServedMessage = "A folder is being served as VDFS. Type *VDFS to use it.";

/**
 * Has the page hand its open files to the folder when it is going away, and says through `notify` what the person
 * needs to know: that the folder cannot be used, or cannot be written. When the browser has to be asked again, which
 * only a click can do, `offer` gives them the button.
 */
export async function attachBrowserVdfs(host, { notify, offer }) {
    const flush = () => host.flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
    });
    host.onWriteFailure = (error) =>
        notify(`The VDFS folder could not be updated (${error.message}). What the BBC wrote may be lost.`);

    let state;
    try {
        state = await host.store.permission();
    } catch (error) {
        notify(`The VDFS folder could not be checked (${error.message}). Choose it again from the More menu.`);
        return;
    }
    if (state === "none") notify("No folder has been chosen to serve as VDFS. Choose one from the More menu.");
    else if (state === "denied")
        notify("The browser will not let the page use the VDFS folder. Allow it in the site settings.");
    else if (state === "prompt")
        offer("The browser needs to be told again that the VDFS folder may be used.", "Allow", async () => {
            try {
                const answer = await host.store.requestPermission();
                if (answer !== "granted") notify("The browser did not allow the VDFS folder to be used.");
                else notify(ServedMessage, { quietKey: "quietVdfs" });
            } catch (error) {
                notify(
                    `The browser could not be asked (${error.message}). Choose the folder again from the More menu.`,
                );
            }
        });
    else if (state === "granted") notify(ServedMessage, { quietKey: "quietVdfs" });
    else
        notify(`The browser gave an answer VDFS does not know (${state}). Choose the folder again from the More menu.`);
}

const RealFolders = { pick: pickFolder, save: saveFolder, forget: forgetFolder };

/**
 * Serving a folder starts the machine again with it, so the menu asks first, hands what is open to the folder it has,
 * and keeps or forgets the folder only once the answer is yes.
 */
export function attachVdfsMenu({ urlState, modals, serving, notify, flush = async () => {}, folders = RealFolders }) {
    const serve = document.getElementById("vdfs-serve");
    const stop = document.getElementById("vdfs-stop");
    serve.hidden = false;
    stop.hidden = !serving;

    const onClick = (element, action) =>
        element.addEventListener("click", async (event) => {
            event.preventDefault();
            try {
                await action();
            } catch (error) {
                notify(`The VDFS folder could not be changed (${error.message}).`);
            }
        });

    onClick(serve, async () => {
        let handle;
        try {
            handle = await folders.pick();
        } catch (error) {
            if (error.name === "AbortError") return;
            throw error;
        }
        const message = `Serve "${handle.name}" as VDFS? The BBC restarts, and then *VDFS selects it.`;
        if (!(await modals.confirm(message, "Restart", "Cancel"))) return;
        await flush();
        await folders.save(handle);
        reloadAsMachine(urlState, { vdfs: true });
    });
    onClick(stop, async () => {
        if (!(await modals.confirm("Stop serving the VDFS folder? The BBC restarts.", "Restart", "Cancel"))) return;
        await flush();
        await folders.forget();
        reloadAsMachine(urlState, { vdfs: undefined });
    });
}
