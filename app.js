const {app, BrowserWindow} = require('electron');


function createWindow() {
    let win = new BrowserWindow({
        width: 1280,
        height: 1024,
        webPreferences: {
            nodeIntegration: false
        }
    });
    win.loadFile('index.html');
}

app.whenReady().then(createWindow);