const { app, BrowserWindow, ipcMain, shell, session, globalShortcut, screen, Tray, Menu, nativeImage } = require("electron");
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
const agent = require("./lib/agent");

let win = null;
let overlay = null;
let tray = null;
let quitting = false;

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
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function showMain() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, "assets", "zeno.png")).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip("ZENO · ctrl+y for the assistant");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open ZENO", click: showMain },
    { label: "Assistant (Ctrl+Y)", click: toggleOverlay },
    { type: "separator" },
    { label: "Quit ZENO", click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on("click", showMain);
}

function createOverlay() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlay = new BrowserWindow({
    width: 460,
    height: 260,
    x: Math.round((width - 460) / 2),
    y: 8,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile("overlay.html");
  overlay.on("blur", () => {
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
      overlay.webContents.send("overlay:soft-hide");
    }
  });
}

function toggleOverlay() {
  if (!overlay || overlay.isDestroyed()) createOverlay();
  if (overlay.isVisible()) {
    overlay.hide();
  } else {
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    overlay.setPosition(Math.round((width - 460) / 2), 8);
    overlay.show();
    overlay.focus();
    overlay.webContents.send("overlay:activate");
  }
}

app.on("second-instance", () => {
  showMain();
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "audioCapture");
  });
  plugins.load();
  createWindow();
  createOverlay();
  createTray();
  globalShortcut.register("Control+Y", toggleOverlay);
  system.setWakeEnabled(config.load().wakeWord);
  app.on("activate", () => {
    showMain();
  });
});

app.on("before-quit", () => {
  quitting = true;
  system.shutdown();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {});

ipcMain.handle("open:external", (_event, url) => {
  if (/^https?:\/\//i.test(String(url))) {
    shell.openExternal(url);
  }
});

ipcMain.handle("overlay:hide", () => {
  if (overlay && !overlay.isDestroyed()) overlay.hide();
  return true;
});

ipcMain.handle("overlay:resize", (_event, height) => {
  if (overlay && !overlay.isDestroyed()) {
    const clamped = Math.max(70, Math.min(520, Math.round(Number(height) || 70)));
    overlay.setBounds({ ...overlay.getBounds(), height: clamped });
  }
  return true;
});

ipcMain.handle("overlay:open-main", () => {
  if (overlay && !overlay.isDestroyed()) overlay.hide();
  showMain();
  return true;
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
agent.register(ipcMain);
