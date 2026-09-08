// Electron integration for jsbeeb desktop application.
// Handles IPC communication for loading disc/tape images and showing modals from Electron's main process.

import { reportLoadFailure } from "../web/reporting.js";

function init(args) {
    const { loadStateFile, modals, actions, settings, media, drives } = args;
    const api = window.electronAPI;

    api.onLoadDisc(async (message) => {
        const { drive, path } = message;
        const claim = drives.claim(drive);
        try {
            const loaded = await media.loadDiscImage(path, drives.layoutForDrive(drive));
            if (drives.putDiscIn(drive, loaded, claim)) media.setDiscImage(drive, path);
        } catch (error) {
            reportLoadFailure(`disc ${path}`, error);
        }
    });

    api.onLoadTape(async (message) => {
        const { path } = message;
        const claim = media.claimTape();
        try {
            if (media.setProcessorTape(await media.loadTapeImage(path), claim)) media.setTapeImage(path);
        } catch (error) {
            reportLoadFailure(`tape ${path}`, error);
        }
    });

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
        media.addEventListener("media-changed", (e) => {
            api.saveSettings(e.detail);
        });
    }
}

export function initialise(args) {
    if (typeof window.electronAPI !== "undefined") {
        init(args);
    }
}
