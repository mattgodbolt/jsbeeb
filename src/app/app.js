import { app, BrowserWindow, dialog, ipcMain, Menu, shell, nativeImage } from "electron";
import Store from "electron-store";
import * as fs from "fs";
import * as path from "path";
import { ArgumentParser } from "argparse";

import { getArguments } from "./args.js";
import { FsStore } from "../vdfs-fs-store.js";
import { isAppPage } from "./app-page.js";
import { drainVdfs, pageKeepsRunning, swapVdfsFolder } from "./vdfs-swap.js";

const store = new Store();

// The folder served as VDFS is the main process's to name: the page can only use the one it was given.
const savedFolder = store.get("vdfsFolder");
const isFolder = (folder) => typeof folder === "string" && fs.existsSync(folder) && fs.statSync(folder).isDirectory();
let vdfsStore = isFolder(savedFolder) ? new FsStore(savedFolder) : null;
const pendingVdfsOperations = new Set();
const FlushTimeoutMs = 3000;
const AppPagePath = path.join(app.getAppPath(), "dist", "index.html");
let vdfsEpoch = 0;
let mainWindow = null;
let readyToQuit = false;

function vdfsOperation(run) {
    if (!vdfsStore) return Promise.reject(new Error("No folder is being served as VDFS"));
    const operation = Promise.resolve().then(() => run(vdfsStore));
    pendingVdfsOperations.add(operation);
    const forget = () => pendingVdfsOperations.delete(operation);
    operation.then(forget, forget);
    return operation;
}

const isNames = (value) => Array.isArray(value) && value.every((name) => typeof name === "string");
const isPath = (value) => isNames(value) && value.length > 0;

/** Answers `channel` for the app's own page, as the page it was served for. Whatever else the window shows has no folder. */
function handleVdfs(channel, handler) {
    ipcMain.handle(channel, (event, epoch, ...args) => {
        if (!isAppPage(event, AppPagePath)) throw new Error("Only the app's own page may use the VDFS folder");
        if (epoch !== vdfsEpoch) throw new Error("The VDFS folder has changed");
        return handler(...args);
    });
}

ipcMain.on("vdfs-epoch", (event) => {
    event.returnValue = isAppPage(event, AppPagePath) ? vdfsEpoch : -1;
});

handleVdfs("vdfs-find", (directory, name) => {
    if (!isNames(directory) || typeof name !== "string") throw new Error("Not a VDFS name to find");
    return vdfsOperation((vdfs) => vdfs.find(directory, name));
});
handleVdfs("vdfs-list", (directory) => {
    if (!isNames(directory)) throw new Error("Not a VDFS directory to list");
    return vdfsOperation((vdfs) => vdfs.list(directory));
});
handleVdfs("vdfs-read", (volumePath) => {
    if (!isPath(volumePath)) throw new Error("Not a VDFS file to read");
    return vdfsOperation((vdfs) => vdfs.read(volumePath));
});
handleVdfs("vdfs-write-file", (volumePath, details) => {
    if (!isPath(volumePath) || !(details?.data instanceof Uint8Array)) throw new Error("Not a VDFS file to write");
    const { data, load, exec, locked } = details;
    return vdfsOperation((vdfs) =>
        vdfs.writeFile(volumePath, { data, load: load >>> 0, exec: exec >>> 0, locked: !!locked }),
    );
});
handleVdfs("vdfs-set-info", (volumePath, changes) => {
    if (!isPath(volumePath) || typeof changes !== "object" || changes === null)
        throw new Error("Not VDFS information to set");
    const { load, exec, locked } = changes;
    return vdfsOperation((vdfs) =>
        vdfs.setInfo(volumePath, {
            ...(load !== undefined && { load: load >>> 0 }),
            ...(exec !== undefined && { exec: exec >>> 0 }),
            ...(locked !== undefined && { locked: !!locked }),
        }),
    );
});
handleVdfs("vdfs-make-directory", (volumePath) => {
    if (!isPath(volumePath)) throw new Error("Not a VDFS directory to make");
    return vdfsOperation((vdfs) => vdfs.makeDirectory(volumePath));
});
handleVdfs("vdfs-remove", (volumePath) => {
    if (!isPath(volumePath)) throw new Error("Not a VDFS file to remove");
    return vdfsOperation((vdfs) => vdfs.remove(volumePath));
});

let menuPanels = [];

ipcMain.on("set-title", (event, title) => {
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    if (win) win.setTitle(title);
});

ipcMain.on("set-panels", (event, panels) => {
    menuPanels = panels;
    setMenu(panels);
});

ipcMain.on("save-settings", (event, settings) => {
    const current = store.get("settings", {});
    store.set("settings", { ...current, ...settings });
});

const isMac = process.platform === "darwin";

const parser = new ArgumentParser({
    prog: "jsbeeb",
    add_help: true,
    description: "Emulate a Beeb",
});
parser.add_argument("--noboot", {
    action: "store_true",
    help: "don't autoboot if given a disc image",
});
parser.add_argument("disc1", {
    nargs: "?",
    help: "image to load in drive 0",
});
parser.add_argument("disc2", {
    nargs: "?",
    help: "image to load in drive 1",
});
const args = parser.parse_args(getArguments());

function getFileParam(filename) {
    try {
        return "file://" + fs.realpathSync(filename);
    } catch (e) {
        console.error("Unable to open file " + filename);
        throw e;
    }
}

const pageQuery = () => ({ ...store.get("settings", {}), ...(vdfsStore && { vdfs: 1 }) });

async function createWindow() {
    const iconPath = path.join(import.meta.dirname, "..", "..", "public", "jsbeeb-icon.png");
    const icon = nativeImage.createFromPath(iconPath);

    const win = (mainWindow = new BrowserWindow({
        width: 1280,
        height: 1024,
        icon: icon,
        webPreferences: {
            preload: path.join(import.meta.dirname, "preload.js"),
        },
    }));

    // Load saved settings, then override with command-line args
    const query = pageQuery();
    if (args.disc1 && !args.noboot) query.autoboot = true;
    if (args.disc1) query.disc1 = getFileParam(args.disc1);
    if (args.disc2) query.disc2 = getFileParam(args.disc2);
    // What the BBC has written is handed over before the window goes, for the writes that close would not wait for.
    let flushedForClose = false;
    win.on("close", (event) => {
        if (!vdfsStore || flushedForClose || readyToQuit) return;
        event.preventDefault();
        drainVdfs({ flushPages: () => [askPageToFlush(win)], inFlight: () => pendingVdfsOperations }).finally(() => {
            flushedForClose = true;
            win.close();
        });
    });
    await win.loadFile("dist/index.html", { query });

    app.on("activate", function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}

// A quit closes the windows, and a close the page has not flushed for is held back, which would cancel the quit.
app.on("before-quit", (event) => {
    const windows = BrowserWindow.getAllWindows();
    if (readyToQuit || !vdfsStore || windows.length === 0) return;
    event.preventDefault();
    drainVdfs({ flushPages: () => windows.map(askPageToFlush), inFlight: () => pendingVdfsOperations }).finally(() => {
        readyToQuit = true;
        app.quit();
    });
});

app.on("window-all-closed", function () {
    // Quit after the final window closes, once any writes to the VDFS folder have settled.
    Promise.allSettled([...pendingVdfsOperations]).then(() => app.quit());
});

app.whenReady()
    .then(createWindow)
    .catch((e) => {
        console.error("Unhandled exception", e);
        app.exit(1);
    });

/** A menu click that asks for a file and sends its path to the page; `setting`, if given, remembers the path. */
function pickFile({ title, filters, channel, message, setting }) {
    return async (_, browserWindow) => {
        const result = await dialog.showOpenDialog(browserWindow, { title, filters, properties: ["openFile"] });
        if (result.canceled) return;
        const filePath = getFileParam(result.filePaths[0]);
        if (setting) store.set(setting, filePath);
        browserWindow.webContents.send(channel, { ...message, path: filePath });
    };
}

const loadDisc = (drive) =>
    pickFile({
        title: "Load a disc image",
        filters: [
            { name: "Disc images", extensions: ["ssd", "dsd"] },
            { name: "ZIPped disc images", extensions: ["zip"] },
        ],
        channel: "load",
        message: { drive },
        setting: `settings.disc${drive + 1}`,
    });

/** Waits for the page to say it has handed over what the BBC wrote, so none of it reaches the folder after this. */
function askPageToFlush(browserWindow) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            ipcMain.removeListener("vdfs-flushed", answered);
            resolve();
        };
        const answered = (event) => {
            if (event.sender === browserWindow.webContents && isAppPage(event, AppPagePath)) done();
        };
        const timer = setTimeout(done, FlushTimeoutMs);
        ipcMain.on("vdfs-flushed", answered);
        browserWindow.webContents.send("vdfs-flush");
    });
}

/** The window the emulator is in, whichever window a menu click was for: the others have no folder to change. */
const emulatorWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

/** Serves `folder` as VDFS, or no folder, and starts the page again, which has to be built with it. */
async function serveVdfsFolder(folder) {
    const browserWindow = emulatorWindow();
    // A page that has VDFS already has its ROM, and finds the new folder on its next call; any other starts again.
    const pageHasVdfs = pageKeepsRunning({ wasServing: vdfsStore !== null, folder });
    if (browserWindow && !pageHasVdfs) {
        const { response } = await dialog.showMessageBox(browserWindow, {
            type: "question",
            message: folder ? "Serve this folder as VDFS?" : "Stop serving the VDFS folder?",
            detail: "The BBC restarts, and anything in it that is not saved is lost.",
            buttons: ["Restart", "Cancel"],
            defaultId: 0,
            cancelId: 1,
        });
        if (response !== 0) return;
    }
    await swapVdfsFolder({
        flushPages: () => (vdfsStore && browserWindow ? [askPageToFlush(browserWindow)] : []),
        inFlight: () => pendingVdfsOperations,
        changeFolder: () => {
            if (folder) store.set("vdfsFolder", folder);
            else store.delete("vdfsFolder");
            vdfsStore = folder ? new FsStore(folder) : null;
            vdfsEpoch++;
            setMenu(menuPanels);
        },
        loadPage: async () => {
            if (!browserWindow || browserWindow.isDestroyed()) return;
            if (pageHasVdfs) browserWindow.webContents.send("vdfs-changed", vdfsEpoch);
            else await browserWindow.loadFile("dist/index.html", { query: pageQuery() });
        },
    });
}

async function chooseVdfsFolder() {
    const browserWindow = emulatorWindow();
    const result = await dialog.showOpenDialog(...(browserWindow ? [browserWindow] : []), {
        title: "Choose a folder to serve as VDFS",
        properties: ["openDirectory", "createDirectory"],
    });
    if (!result.canceled) await serveVdfsFolder(result.filePaths[0]);
}

function showModal(modalId) {
    return (_, browserWindow) => {
        browserWindow.webContents.send("show-modal", { modalId });
    };
}

function sendAction(actionId) {
    return (_, browserWindow) => {
        browserWindow.webContents.send("action", { actionId });
    };
}

/** The Debug menu: into and out of the debugger, and every panel the page lists under its group, ticked while open. */
function debugMenu(panels) {
    return {
        label: "Debug",
        submenu: [
            // Shown, not registered, so the keys reach the page, which answers them. A Mac would register them anyway,
            // taking Option-S and Option-D from the page's text fields, so there they are not shown.
            {
                label: "Enter or Leave the Debugger",
                ...(!isMac && { accelerator: "Alt+S", registerAccelerator: false }),
                click: sendAction("toggle-debugger"),
            },
            {
                label: "Show or Hide the Debug Panels",
                ...(!isMac && { accelerator: "Alt+D", registerAccelerator: false }),
                click: sendAction("toggle-debug-panels"),
            },
            ...panels.flatMap(({ id, title, menuGroup, open }, index) => [
                ...(menuGroup === panels[index - 1]?.menuGroup
                    ? []
                    : [{ type: "separator" }, { label: menuGroup, enabled: false }]),
                {
                    label: title,
                    type: "checkbox",
                    checked: open,
                    click: (_, browserWindow) => browserWindow.webContents.send("toggle-panel", { id }),
                },
            ]),
        ],
    };
}

const template = (panels) => [
    // { role: 'appMenu' }
    ...(isMac
        ? [
              {
                  label: app.name,
                  submenu: [
                      { role: "about" },
                      { type: "separator" },
                      { role: "services" },
                      { type: "separator" },
                      { role: "hide" },
                      { role: "hideothers" },
                      { role: "unhide" },
                      { type: "separator" },
                      { role: "quit" },
                  ],
              },
          ]
        : []),
    // { role: 'fileMenu' }
    {
        label: "File",
        submenu: [
            {
                label: "Load disc 0...",
                click: loadDisc(0),
            },
            {
                label: "Load disc 1...",
                click: loadDisc(1),
            },
            { type: "separator" },
            {
                label: "Discs and Tapes...",
                click: sendAction("media"),
            },
            {
                label: "Serve VDFS Folder...",
                click: chooseVdfsFolder,
            },
            {
                label: "Stop Serving VDFS Folder",
                enabled: vdfsStore !== null,
                click: () => serveVdfsFolder(null),
            },
            { type: "separator" },
            {
                label: "Load Tape from File...",
                click: pickFile({
                    title: "Load a tape image",
                    filters: [
                        { name: "Tape images", extensions: ["uef"] },
                        { name: "ZIPped tape images", extensions: ["zip"] },
                    ],
                    channel: "load-tape",
                    message: {},
                    setting: "settings.tape",
                }),
            },
            { type: "separator" },
            isMac ? { role: "close" } : { role: "quit" },
        ],
    },
    // { role: 'editMenu' }
    {
        label: "Edit",
        submenu: [{ role: "paste" }],
    },
    // { role: 'viewMenu' }
    {
        label: "View",
        submenu: [
            { role: "reload" },
            { role: "forcereload" },
            { role: "toggledevtools" },
            { type: "separator" },
            { role: "resetzoom" },
            { role: "zoomin" },
            { role: "zoomout" },
            { type: "separator" },
            { role: "togglefullscreen" },
        ],
    },
    {
        label: "Machine",
        submenu: [
            {
                label: "Settings...",
                click: showModal("configuration"),
            },
            { type: "separator" },
            {
                label: "Save State...",
                accelerator: "CmdOrCtrl+S",
                click: sendAction("save-state"),
            },
            {
                label: "Load State...",
                accelerator: "CmdOrCtrl+O",
                click: pickFile({
                    title: "Load emulator state",
                    filters: [
                        { name: "Snapshot files", extensions: ["gz", "json", "snp", "uef"] },
                        { name: "All files", extensions: ["*"] },
                    ],
                    channel: "load-state",
                    message: {},
                    setting: undefined,
                }),
            },
            { type: "separator" },
            {
                label: "Rewind...",
                ...(!isMac && { accelerator: "Alt+W", registerAccelerator: false }),
                click: sendAction("rewind"),
            },
            { type: "separator" },
            {
                // No accelerator: Alt-S reaches the page, where it toggles rather than only stopping. Unlike Debug's
                // item, Pause never leaves the debugger and Resume never closes its panels.
                label: "Pause and Show Debugger",
                click: sendAction("pause"),
            },
            {
                label: "Resume",
                click: sendAction("resume"),
            },
            { type: "separator" },
            {
                label: "Soft Reset",
                click: sendAction("soft-reset"),
            },
            {
                label: "Hard Reset",
                click: sendAction("hard-reset"),
            },
        ],
    },
    debugMenu(panels),
    {
        role: "help",
        submenu: [
            {
                label: "Help...",
                click: showModal("help"),
            },
            {
                label: "About jsbeeb...",
                click: showModal("info"),
            },
            { type: "separator" },
            {
                label: "Learn More",
                click: async () => {
                    await shell.openExternal("https://github.com/mattgodbolt/jsbeeb/");
                },
            },
        ],
    },
];

function setMenu(panels) {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template(panels)));
}

setMenu([]);
