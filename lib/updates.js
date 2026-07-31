const { app } = require("electron");

const RELEASES_API = "https://api.github.com/repos/iamyakay/zeno/releases/latest";
const RELEASES_PAGE = "https://github.com/iamyakay/zeno/releases/latest";

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
      return { update: true, current, latest, url: data?.html_url || RELEASES_PAGE };
    }
    return { update: false, current, latest };
  } catch {
    return { update: false, current };
  }
}

function register(ipcMain) {
  ipcMain.handle("app:update-check", () => check());
  ipcMain.handle("app:version", () => app.getVersion());
}

module.exports = { register };
