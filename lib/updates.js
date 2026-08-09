const { app, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const config = require("./config");

const RELEASES_API = "https://api.github.com/repos/iamyakay/zeno/releases/latest";
const RELEASES_PAGE = "https://github.com/iamyakay/zeno/releases/latest";

let downloading = false;

function isNewer(latest, current) {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

async function check() {
  const current = app.getVersion();
  try {
    const response = await fetch(RELEASES_API, {
      headers: { "User-Agent": "zeno-app", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return { update: false, current };
    const data = await response.json();
    const latest = String(data?.tag_name || "").replace(/^v/, "");
    if (latest && isNewer(latest, current)) {
      const asset = (data?.assets || []).find((a) => /ZENO-Setup.*\.exe$/i.test(a.name));
      return { update: true, current, latest, url: data?.html_url || RELEASES_PAGE, downloadUrl: asset?.browser_download_url || null };
    }
    return { update: false, current, latest };
  } catch {
    return { update: false, current };
  }
}

async function downloadInstaller(downloadUrl, onProgress) {
  if (downloading) return null;
  downloading = true;
  const dest = path.join(app.getPath("temp"), `ZENO-update-${Date.now()}.exe`);
  try {
    const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length") || 0);
    const file = fs.createWriteStream(dest);
    const reader = response.body.getReader();
    let got = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (total) onProgress?.(Math.round((got / total) * 100));
      await new Promise((resolve, reject) => file.write(Buffer.from(value), (err) => err ? reject(err) : resolve()));
    }
    await new Promise((resolve) => file.end(resolve));
    return dest;
  } catch (error) {
    try { fs.rmSync(dest, { force: true }); } catch {}
    return null;
  } finally {
    downloading = false;
  }
}

function installOnQuit(installerPath) {
  app.on("before-quit", () => {
    try {
      const child = spawn(installerPath, [], { detached: true, stdio: "ignore", shell: false });
      child.unref();
    } catch {
      shell.openPath(installerPath).catch(() => {});
    }
  });
}

function register(ipcMain) {
  ipcMain.handle("app:update-check", () => check());
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:update-download", async (event, downloadUrl) => {
    const dest = await downloadInstaller(downloadUrl, (pct) => {
      if (!event.sender.isDestroyed()) event.sender.send("app:update-progress", pct);
    });
    if (dest) {
      installOnQuit(dest);
      return { ok: true, path: dest };
    }
    return { ok: false };
  });
}

module.exports = { register };
