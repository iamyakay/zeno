const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const file = path.join(app.getPath("userData"), "zeno-config.json");

const defaults = {
  apiKey: "",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  primaryModel: "google/gemma-4-26b-a4b-it:free",
  visionModel: "google/gemma-4-26b-a4b-it:free",
  consensusModels: [
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-nano-12b-v2-vl:free"
  ],
  judgeModel: "google/gemma-4-26b-a4b-it:free",
  consensusEnabled: false,
  voiceReplies: true,
  wakeWord: false,
  theme: "green",
  userName: "Zap",
  persona: "",
  micDevice: "",
  conversationMode: false,
  autoUpdate: true,
  startWithWindows: false
};

const retired = new Set([
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free"
]);

function migrate(config) {
  let changed = false;
  for (const key of ["primaryModel", "visionModel", "judgeModel"]) {
    if (retired.has(config[key])) {
      config[key] = defaults[key];
      changed = true;
    }
  }
  if (Array.isArray(config.consensusModels) && config.consensusModels.some((m) => retired.has(m))) {
    config.consensusModels = [...defaults.consensusModels];
    changed = true;
  }
  return changed;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const merged = { ...defaults, ...raw };
    if (migrate(merged)) {
      save(merged);
    }
    return merged;
  } catch {
    return { ...defaults };
  }
}

function save(config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

function register(ipcMain, hooks) {
  ipcMain.handle("config:get", () => load());
  ipcMain.handle("config:set", (_event, partial) => {
    const next = { ...load(), ...partial };
    save(next);
    hooks?.onChange?.(partial, next);
    return next;
  });
}

module.exports = { load, save, defaults, register };
