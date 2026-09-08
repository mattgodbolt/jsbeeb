// Electron integration for jsbeeb desktop application.
// Handles IPC communication for loading disc/tape images and showing modals from Electron's main process.

import { describeRef } from "../web/media-catalogue.js";

function init(args) {
    const { loadStateFile, modals, actions, settings, media } = args;
    const api = window.electronAPI;
    const { slots } = media;

    api.onLoadDisc(({ drive, path }) => slots.load(slots.drive(drive), describeRef(path, "disc")));
    api.onLoadTape(({ path }) => slots.load(slots.deck, describeRef(path, "tape")));

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

export function initialise(args) {
    if (typeof window.electronAPI !== "undefined") {
        init(args);
    }
}
