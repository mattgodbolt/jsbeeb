"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Which folder this page is talking to. A call carries it, so that one that outlives a change of folder is refused,
// and does not land in the new one.
let vdfsEpoch = ipcRenderer.sendSync("vdfs-epoch");
const vdfsCall = (channel, ...args) => ipcRenderer.invoke(channel, vdfsEpoch, ...args);

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
    // Main asks the page to hand over what it has written before it changes the folder, and hears when it has.
    onVdfsFlush: (callback) =>
        ipcRenderer.on("vdfs-flush", async () => {
            try {
                await callback();
            } finally {
                ipcRenderer.send("vdfs-flushed");
            }
        }),
    // Main says the folder has changed, so that the calls it held back can go on.
    onVdfsChanged: (callback) =>
        ipcRenderer.on("vdfs-changed", (event, epoch) => {
            vdfsEpoch = epoch;
            callback();
        }),
    // The store behind a VDFS volume, whose folder only the main process can reach.
    vdfs: {
        find: (directory, name) => vdfsCall("vdfs-find", directory, name),
        list: (directory) => vdfsCall("vdfs-list", directory),
        read: (path) => vdfsCall("vdfs-read", path),
        writeFile: (path, details) => vdfsCall("vdfs-write-file", path, details),
        setInfo: (path, changes) => vdfsCall("vdfs-set-info", path, changes),
        makeDirectory: (path) => vdfsCall("vdfs-make-directory", path),
        remove: (path) => vdfsCall("vdfs-remove", path),
    },
});

window.addEventListener("DOMContentLoaded", () => {
    for (const node of document.getElementsByClassName("not-electron")) {
        node.remove();
    }
});
