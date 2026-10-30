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
