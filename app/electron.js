"use strict";

// Left for posterity and the hope that one day Electron (the standalone app generator)
// supports ES Modules. See https://github.com/electron/electron/issues/21457

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
