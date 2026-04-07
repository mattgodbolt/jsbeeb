"use strict";

// Electron integration for jsbeeb desktop application.
// Handles IPC communication for loading disc/tape images and showing modals from Electron's main process.

function init(args) {
    const { loadDiscImage, loadTapeImage, loadFolderAsDisc, loadStateFile, processor, modals, actions, config } = args;
    const api = window.electronAPI;

    api.onLoadDisc(async (message) => {
        const { drive, path } = message;
        const image = await loadDiscImage(path);
        processor.fdc.loadDisc(drive, image);
    });

    api.onLoadTape(async (message) => {
        const { path } = message;
        const tape = await loadTapeImage(path);
        processor.acia.setTape(tape);
    });

    api.onLoadFolder(async (message) => {
        // The main process sends serialised file data as an array of
        // { name: string, data: number[] } objects.
        const fileObjects = message.files.map(({ name, data }) => new File([new Uint8Array(data)], name));
        await loadFolderAsDisc(fileObjects);
    });

    api.onShowModal((message) => {
        const { modalId, sthType } = message;
        if (modals && modals.show) {
            modals.show(modalId, sthType);
        }
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
    if (config) {
        config.addEventListener("settings-changed", (e) => {
            api.saveSettings(e.detail);
        });
        config.addEventListener("media-changed", (e) => {
            api.saveSettings(e.detail);
        });
    }
}

export function initialise(args) {
    if (typeof window.electronAPI !== "undefined") {
        init(args);
    }
}
