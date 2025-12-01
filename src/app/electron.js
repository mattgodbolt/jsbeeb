"use strict";

// Electron integration for jsbeeb desktop application.
// Handles IPC communication for loading disc/tape images and showing modals from Electron's main process.

export let initialise = function () {};
export let setTitle = function () {};

function init(args) {
    const { loadDiscImage, loadTapeImage, processor, modals, actions } = args;
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
}

if (typeof window.electronAPI !== "undefined") {
    initialise = init;
    setTitle = (title) => window.electronAPI.setTitle(`jsbeeb - ${title}`);
}
