const { app, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { runPs } = require("./system");

const plugins = new Map();

function loadFrom(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const plugin = require(path.join(dir, file));
      if (plugin?.name && plugin?.pattern instanceof RegExp && typeof plugin.run === "function") {
        plugins.set(plugin.name, plugin);
      }
    } catch (error) {
      console.error(`plugin ${file} failed to load:`, error?.message);
    }
  }
}

function load() {
  loadFrom(path.join(__dirname, "..", "plugins"));
  const userDir = path.join(app.getPath("userData"), "plugins");
  fs.mkdirSync(userDir, { recursive: true });
  loadFrom(userDir);
}

function register(ipcMain) {
  ipcMain.handle("plugins:list", () => {
    return [...plugins.values()].map((p) => ({
      name: p.name,
      description: p.description || "",
      pattern: { source: p.pattern.source, flags: p.pattern.flags }
    }));
  });

  ipcMain.handle("plugins:run", async (_event, payload) => {
    const plugin = plugins.get(payload?.name);
    if (!plugin) return { ok: false, error: "plugin not found" };
    try {
      const ctx = {
        fetch,
        openUrl: (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); },
        ps: runPs
      };
      const reply = await Promise.race([
        plugin.run(String(payload.input || ""), ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error("plugin timed out")), 30000))
      ]);
      return { ok: true, text: String(reply ?? "done") };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });
}

module.exports = { load, register };
