const { app, BrowserWindow, ipcMain, shell, session } = require("electron");
const path = require("node:path");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const config = require("./lib/config");
const store = require("./lib/store");
const ai = require("./lib/ai");
const system = require("./lib/system");
const plugins = require("./lib/plugins");
const updates = require("./lib/updates");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#04070a",
    autoHideMenuBar: true,
    title: "ZENO",
    icon: path.join(__dirname, "assets", "zeno.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile("index.html");
}

app.on("second-instance", () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "audioCapture");
  });
  plugins.load();
  createWindow();
  system.setWakeEnabled(config.load().wakeWord);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  system.shutdown();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("open:external", (_event, url) => {
  if (/^https?:\/\//i.test(String(url))) {
    shell.openExternal(url);
  }
});

config.register(ipcMain, {
  onChange(partial, next) {
    if ("wakeWord" in partial) system.setWakeEnabled(next.wakeWord);
  }
});
store.register(ipcMain);
ai.register(ipcMain);
system.register(ipcMain, () => win);
plugins.register(ipcMain);
updates.register(ipcMain);
