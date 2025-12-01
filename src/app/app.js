"use strict";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, nativeImage } from "electron";
import Store from "electron-store";
import * as fs from "fs";
import * as path from "path";
import { ArgumentParser } from "argparse";

const store = new Store();

ipcMain.on("set-title", (event, title) => {
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    if (win) win.setTitle(title);
});

ipcMain.on("save-settings", (event, settings) => {
    const current = store.get("settings", {});
    store.set("settings", { ...current, ...settings });
});

const isMac = process.platform === "darwin";

function getArguments() {
    // Heinous hack to get "built" versions working
    let args;
    if (path.basename(process.argv[0]) === "jsbeeb")
        // Is this ia "built" version?
        args = process.argv.slice(1);
    else args = process.argv.slice(2);

    // Filter out Chrome switches that appear in process.argv. The snap wrapper
    // adds --no-sandbox for compatibility, and `--disable-gpu` might be useful.
    // Note that we don't support snap any more, but these seemed useful to leave.
    const ignoredChromeFlags = ["--no-sandbox", "--disable-gpu"];
    return args.filter((arg) => !ignoredChromeFlags.includes(arg));
}

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

async function createWindow() {
    const iconPath = path.join(import.meta.dirname, "..", "..", "public", "jsbeeb-icon.png");
    const icon = nativeImage.createFromPath(iconPath);

    const win = new BrowserWindow({
        width: 1280,
        height: 1024,
        icon: icon,
        webPreferences: {
            preload: path.join(import.meta.dirname, "preload.js"),
        },
    });

    // Load saved settings, then override with command-line args
    const savedSettings = store.get("settings", {});
    const query = { ...savedSettings };
    if (args.disc1 && !args.noboot) query.autoboot = true;
    if (args.disc1) query.disc1 = getFileParam(args.disc1);
    if (args.disc2) query.disc2 = getFileParam(args.disc2);
    await win.loadFile("dist/index.html", { query });

    app.on("activate", function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}

app.on("window-all-closed", function () {
    if (process.platform !== "darwin") app.quit();
});

app.whenReady()
    .then(createWindow)
    .catch((e) => {
        console.error("Unhandled exception", e);
        app.exit(1);
    });

function makeLoader(drive) {
    return async (_, browserWindow) => {
        const result = await dialog.showOpenDialog(browserWindow, {
            title: "Load a disc image",
            filters: [
                { name: "Disc images", extensions: ["ssd", "dsd"] },
                { name: "ZIPped disc images", extensions: ["zip"] },
            ],
            properties: ["openFile"],
        });
        if (!result.canceled) {
            const filePath = getFileParam(result.filePaths[0]);
            store.set(`settings.disc${drive + 1}`, filePath);
            browserWindow.webContents.send("load", { drive, path: filePath });
        }
    };
}

function makeTapeLoader() {
    return async (_, browserWindow) => {
        const result = await dialog.showOpenDialog(browserWindow, {
            title: "Load a tape image",
            filters: [
                { name: "Tape images", extensions: ["uef"] },
                { name: "ZIPped tape images", extensions: ["zip"] },
            ],
            properties: ["openFile"],
        });
        if (!result.canceled) {
            const filePath = getFileParam(result.filePaths[0]);
            store.set("settings.tape", filePath);
            browserWindow.webContents.send("load-tape", { path: filePath });
        }
    };
}

function showModal(modalId, options = {}) {
    return (_, browserWindow) => {
        browserWindow.webContents.send("show-modal", { modalId, ...options });
    };
}

function sendAction(actionId) {
    return (_, browserWindow) => {
        browserWindow.webContents.send("action", { actionId });
    };
}

const template = [
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
                click: makeLoader(0),
            },
            {
                label: "Load disc 1...",
                click: makeLoader(1),
            },
            { type: "separator" },
            {
                label: "Browse STH Disc Archive...",
                click: showModal("sth", { sthType: "discs" }),
            },
            {
                label: "Browse Example Discs...",
                click: showModal("discs"),
            },
            { type: "separator" },
            {
                label: "Load Tape from File...",
                click: makeTapeLoader(),
            },
            {
                label: "Browse STH Tape Archive...",
                click: showModal("sth", { sthType: "tapes" }),
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
                label: "Configuration...",
                click: showModal("configuration"),
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

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
