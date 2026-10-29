// Electron integration for jsbeeb desktop application.
// Handles IPC communication for loading disc/tape images and showing modals from Electron's main process.

import { describeRef } from "../web/media-catalogue.js";

function init(args) {
    const { loadStateFile, modals, actions, settings, media, panels } = args;
    const api = window.electronAPI;
    const { slots } = media;

    api.onLoadDisc(({ drive, path }) => slots.load(slots.drive(drive), describeRef(path, "disc"), { entry: "menu" }));
    api.onLoadTape(({ path }) => slots.load(slots.deck, describeRef(path, "tape"), { entry: "menu" }));

    api.onShowModal((message) => {
        if (modals && modals.show) modals.show(message.modalId);
    });

    api.onAction((message) => {
        if (actions && actions[message.actionId]) {
            actions[message.actionId]();
        }
    });

    api.onLoadState(async (message) => {
        if (loadStateFile) {
            const response = await fetch(message.path);
            const blob = await response.blob();
            const file = new File([blob], message.path.split("/").pop());
            await loadStateFile(file);
        }
    });

    // The app's Debug menu lists the same panels as the page's, which the app has no navbar to show.
    const sendPanels = () =>
        api.setPanels(panels.listed().map(({ id, title, isOpen }) => ({ id, title, open: isOpen })));
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

    // Save settings when they change
    if (settings) {
        settings.addEventListener("change", (e) => {
            api.saveSettings(e.detail);
        });
    }
    if (media) {
        slots.addEventListener("changed", (e) => {
            if (!e.detail.slot.busy) api.saveSettings(e.detail.slot.urlParams());
        });
    }
}

/** Whether the page is running inside the desktop app, whose preload removes the `.not-electron` page furniture. */
export function isDesktopApp() {
    return typeof window.electronAPI !== "undefined";
}

export function initialise(args) {
    if (isDesktopApp()) init(args);
}
