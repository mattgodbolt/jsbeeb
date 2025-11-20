"use strict";

// Electron integration for jsbeeb desktop application.
// Handles IPC communication for loading disc images from Electron's main process.

export let initialise = function () {};

function init(args) {
    const { loadDiscImage, processor } = args;
    const electron = window.nodeRequire("electron");
    electron.ipcRenderer.on("load", async (event, message) => {
        const { drive, path } = message;
        const image = await loadDiscImage(path);
        processor.fdc.loadDisc(drive, image);
    });
}

if (typeof window.nodeRequire !== "undefined") {
    initialise = init;
}
