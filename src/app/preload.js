"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Expose a secure API to the renderer
contextBridge.exposeInMainWorld("electronAPI", {
    onLoadDisc: (callback) => ipcRenderer.on("load", (event, message) => callback(message)),
    onLoadTape: (callback) => ipcRenderer.on("load-tape", (event, message) => callback(message)),
    onShowModal: (callback) => ipcRenderer.on("show-modal", (event, message) => callback(message)),
    onAction: (callback) => ipcRenderer.on("action", (event, message) => callback(message)),
    onLoadState: (callback) => ipcRenderer.on("load-state", (event, message) => callback(message)),
    setTitle: (title) => ipcRenderer.send("set-title", title),
    saveSettings: (settings) => ipcRenderer.send("save-settings", settings),
    setPanels: (panels) => ipcRenderer.send("set-panels", panels),
    onTogglePanel: (callback) => ipcRenderer.on("toggle-panel", (event, message) => callback(message)),
    // The store behind a VDFS volume, whose folder only the main process can reach.
    vdfs: {
        load: () => ipcRenderer.invoke("vdfs-load"),
        writeFile: (path, details) => ipcRenderer.invoke("vdfs-write-file", path, details),
        makeDirectory: (path) => ipcRenderer.invoke("vdfs-make-directory", path),
        remove: (path) => ipcRenderer.invoke("vdfs-remove", path),
    },
});

window.addEventListener("DOMContentLoaded", () => {
    for (const node of document.getElementsByClassName("not-electron")) {
        node.remove();
    }
});
