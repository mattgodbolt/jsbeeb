// Electron integration for jsbeeb desktop application.
// Handles IPC communication for loading disc/tape images and showing modals from Electron's main process.

import { describeRef } from "../web/media-catalogue.js";

function init(args) {
    const { loadStateFile, modals, actions, settings, media, panels } = args;
    const api = window.electronAPI;
    const { slots } = media;

    api.onLoadDisc(({ drive, path }) => slots.load(slots.drive(drive), describeRef(path, "disc"), { entry: "menu" }));
    api.onLoadTape(({ path }) => slots.load(slots.deck, describeRef(path, "tape"), { entry: "menu" }));

    api.onShowModal((message) => modals.show(message.modalId));
    api.onAction((message) => actions[message.actionId]?.());
    api.onLoadState(async (message) => {
        const response = await fetch(message.path);
        const blob = await response.blob();
        await loadStateFile(new File([blob], message.path.split("/").pop()));
    });

    // The app's Debug menu lists the same panels as the page's, which the app has no navbar to show.
    const sendPanels = () =>
        api.setPanels(
            panels.listed().map(({ id, title, menuGroup, isOpen }) => ({ id, title, menuGroup, open: isOpen })),
        );
    sendPanels();
    panels.addEventListener("change", sendPanels);
    api.onTogglePanel(({ id }) =>
        panels
            .listed()
            .find((floating) => floating.id === id)
            ?.toggle(),
    );

    // Observe model name changes and update window title
    const modelElement = document.querySelector(".bbc-model");
    if (modelElement) {
        const updateTitle = () => api.setTitle(`jsbeeb - ${modelElement.textContent}`);
        updateTitle();
        new MutationObserver(updateTitle).observe(modelElement, {
            childList: true,
            characterData: true,
            subtree: true,
        });
    }

    settings.addEventListener("change", (e) => api.saveSettings(e.detail));
    slots.addEventListener("changed", (e) => {
        if (!e.detail.slot.busy) api.saveSettings(e.detail.slot.urlParams());
    });
}

/** Whether the page is running inside the desktop app, whose preload removes the `.not-electron` page furniture. */
export function isDesktopApp() {
    return typeof window.electronAPI !== "undefined";
}

export function initialise(args) {
    if (isDesktopApp()) init(args);
}

/** How long the BBC is kept waiting for the folder to change, at most, if the main process does not say. */
const HoldTimeoutMs = 30000;

/** @returns {object | null} the store of the folder the app was asked to serve as VDFS, which its main process holds */
export function desktopVdfsStore(query) {
    return isDesktopApp() && query.vdfs ? window.electronAPI.vdfs : null;
}

/**
 * Has the page hand its open files to the main process when the page is going or the folder is about to change, and
 * say through `notify` when the main process cannot keep one.
 */
export function attachDesktopVdfs(host, { notify }) {
    let safety;
    window.addEventListener("pagehide", () => host.flush());
    window.electronAPI.onVdfsFlush(async () => {
        clearTimeout(safety);
        safety = setTimeout(() => host.release({ changed: false }), HoldTimeoutMs);
        await host.hold();
    });
    window.electronAPI.onVdfsChanged(() => {
        clearTimeout(safety);
        host.release();
    });
    host.onWriteFailure = (error) =>
        notify(`The VDFS folder could not be updated (${error.message}). What the BBC wrote may be lost.`);
}
