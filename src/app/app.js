import { app, BrowserWindow, dialog, ipcMain, Menu, shell, nativeImage } from "electron";
import Store from "electron-store";
import * as fs from "fs";
import * as path from "path";
import { ArgumentParser } from "argparse";

import { getArguments } from "./args.js";

const store = new Store();

ipcMain.on("set-title", (event, title) => {
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    if (win) win.setTitle(title);
});

ipcMain.on("set-panels", (event, panels) => setMenu(panels));

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
