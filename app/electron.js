"use strict";

export var initialise = function () {};

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
