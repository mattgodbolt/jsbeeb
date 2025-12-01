"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Expose a secure API to the renderer
contextBridge.exposeInMainWorld("electronAPI", {
    onLoadDisc: (callback) => ipcRenderer.on("load", (event, message) => callback(message)),
    onLoadTape: (callback) => ipcRenderer.on("load-tape", (event, message) => callback(message)),
    onShowModal: (callback) => ipcRenderer.on("show-modal", (event, message) => callback(message)),
    onAction: (callback) => ipcRenderer.on("action", (event, message) => callback(message)),
});

window.addEventListener("DOMContentLoaded", () => {
    for (const node of document.getElementsByClassName("not-electron")) {
        node.remove();
    }
});
