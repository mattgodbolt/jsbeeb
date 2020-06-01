define([], function () {
    'use strict';
    if (typeof window.nodeRequire === 'undefined') return function () {
    };

    function init(args) {
        const {loadDiscImage, processor} = args;
        const electron = window.nodeRequire('electron');
        electron.ipcRenderer.on('load', async (event, message) => {
            const {drive, path} = message;
            const image = await loadDiscImage(path);
            processor.fdc.loadDisc(drive, image);
        });
    }

    return init;
});
