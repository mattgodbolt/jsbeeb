"use strict";
const {app, BrowserWindow} = require('electron');
const fs = require('fs');
const path = require('path');
const {ArgumentParser} = require('argparse');

function getArguments() {
    // Heinous hack to get "built" versions working
    if (path.basename(process.argv[0]) === 'jsbeeb') // Is this ia "built" version?
        return process.argv.slice(1);
    return process.argv.slice(2);
}

const parser = new ArgumentParser({
    prog: 'jsbeeb',
    addHelp: true,
    description: 'Emulate a Beeb'
});
parser.addArgument(["--noboot"], {action: 'storeTrue', help: "don't autoboot if given a disc image"});
parser.addArgument(["disc1"], {nargs: '?', help: "image to load in drive 0"});
parser.addArgument(["disc2"], {nargs: '?', help: "image to load in drive 1"});
const args = parser.parseArgs(getArguments());


function getFileParam(filename) {
    try {
        return "file://" + fs.realpathSync(filename);
    } catch (e) {
        console.error("Unable to open file " + filename);
        throw e;
    }
}

async function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 1024,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });

    const query = {};
    if (args.disc1 && !args.noboot) query.autoboot = true;
    if (args.disc1) query.disc1 = getFileParam(args.disc1);
    if (args.disc2) query.disc2 = getFileParam(args.disc2);
    await win.loadFile('index.html', {query});

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
})

app.whenReady().then(createWindow)
    .catch(e => {
        console.error("Unhandled exception", e);
        app.exit(1);
    });