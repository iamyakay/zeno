const { app, BrowserWindow, ipcMain, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const configPath = path.join(app.getPath("userData"), "zeno-config.json");

const defaultConfig = {
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
  theme: "green",
  userName: "Zap"
};

const retiredModels = new Set([
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free"
]);

function migrateConfig(config) {
  let changed = false;
  for (const key of ["primaryModel", "visionModel", "judgeModel"]) {
    if (retiredModels.has(config[key])) {
      config[key] = defaultConfig[key];
      changed = true;
    }
  }
  if (Array.isArray(config.consensusModels) && config.consensusModels.some((m) => retiredModels.has(m))) {
    config.consensusModels = [...defaultConfig.consensusModels];
    changed = true;
  }
  return changed;
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const merged = { ...defaultConfig, ...raw };
    if (migrateConfig(merged)) {
      saveConfig(merged);
    }
    return merged;
  } catch {
    return { ...defaultConfig };
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

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

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "audioCapture");
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("config:get", () => loadConfig());

ipcMain.handle("config:set", (_event, partial) => {
  const next = { ...loadConfig(), ...partial };
  saveConfig(next);
  return next;
});

ipcMain.handle("open:external", (_event, url) => {
  if (/^https?:\/\//i.test(String(url))) {
    shell.openExternal(url);
  }
});

ipcMain.handle("ai:chat", async (_event, payload) => {
  const config = loadConfig();
  const { model, messages, maxTokens } = payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "HTTP-Referer": "https://zeno.local",
        "X-Title": "ZENO"
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens || 2048
      }),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message || `HTTP ${response.status}`;
      return { ok: false, error: message, model };
    }
    const choice = data?.choices?.[0]?.message;
    let text = choice?.content ?? "";
    if (typeof text !== "string") {
      text = Array.isArray(text) ? text.map((part) => part?.text || "").join("") : String(text ?? "");
    }
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!text && choice?.reasoning) {
      text = String(choice.reasoning).trim();
    }
    if (!text) {
      return { ok: false, error: "model returned an empty reply, try another model", model };
    }
    return { ok: true, text, model, usage: data?.usage || null };
  } catch (error) {
    const message = error?.name === "AbortError" ? "request timed out" : String(error?.message || error);
    return { ok: false, error: message, model };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle("ai:models", async () => {
  const config = loadConfig();
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const models = (data?.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      free: /:free$/.test(m.id) || (Number(m?.pricing?.prompt) === 0 && Number(m?.pricing?.completion) === 0),
      vision: Boolean(m?.architecture?.input_modalities?.includes?.("image"))
    }));
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

let listenChild = null;

const LISTEN_SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine",
  "$rec.SetInputToDefaultAudioDevice()",
  "$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))",
  "$rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)",
  "$rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.1)",
  "$result = $rec.Recognize([TimeSpan]::FromSeconds(14))",
  "if ($result) { Write-Output $result.Text }"
].join("; ");

ipcMain.handle("os:listen", () => {
  return new Promise((resolve) => {
    if (listenChild) {
      try { listenChild.kill(); } catch {}
      listenChild = null;
    }
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        listenChild = null;
        resolve(value);
      }
    };
    try {
      listenChild = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", LISTEN_SCRIPT], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish({ ok: false, error: String(error?.message || error) });
      return;
    }
    const killTimer = setTimeout(() => {
      try { listenChild?.kill(); } catch {}
    }, 18000);
    listenChild.stdout.on("data", (chunk) => { output += chunk.toString(); });
    listenChild.on("error", (error) => {
      clearTimeout(killTimer);
      finish({ ok: false, error: String(error?.message || error) });
    });
    listenChild.on("close", () => {
      clearTimeout(killTimer);
      const text = output.trim();
      if (text) {
        finish({ ok: true, text });
      } else {
        finish({ ok: false, error: "didn't catch that, try speaking right after clicking" });
      }
    });
  });
});

ipcMain.handle("os:listen-cancel", () => {
  if (listenChild) {
    try { listenChild.kill(); } catch {}
    listenChild = null;
  }
  return true;
});

ipcMain.handle("ai:image", async (_event, prompt) => {
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `image service returned HTTP ${response.status}` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) {
      return { ok: false, error: "image service returned an empty image" };
    }
    const type = response.headers.get("content-type") || "image/jpeg";
    return { ok: true, dataUrl: `data:${type};base64,${buffer.toString("base64")}` };
  } catch (error) {
    const message = error?.name === "AbortError" ? "image generation timed out" : String(error?.message || error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
});

function runPs(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(error?.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim(), error: code === 0 ? null : `exit code ${code}` });
    });
  });
}

const APP_COMMANDS = {
  notepad: ["notepad.exe"],
  calculator: ["calc.exe"],
  calc: ["calc.exe"],
  paint: ["mspaint.exe"],
  explorer: ["explorer.exe"],
  files: ["explorer.exe"],
  cmd: ["cmd.exe", "/c", "start", "cmd.exe"],
  terminal: ["cmd.exe", "/c", "start", "cmd.exe"]
};

const SITE_SHORTCUTS = {
  browser: "https://www.google.com",
  google: "https://www.google.com",
  youtube: "https://www.youtube.com",
  github: "https://github.com",
  discord: "https://discord.com/app",
  spotify: "https://open.spotify.com",
  reddit: "https://www.reddit.com",
  twitter: "https://x.com",
  x: "https://x.com",
  twitch: "https://www.twitch.tv",
  gmail: "https://mail.google.com",
  maps: "https://www.google.com/maps",
  netflix: "https://www.netflix.com",
  openrouter: "https://openrouter.ai"
};

ipcMain.handle("os:action", async (_event, action) => {
  try {
    if (action.type === "url") {
      const url = String(action.url || "");
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "only http links allowed" };
      await shell.openExternal(url);
      return { ok: true, detail: url };
    }
    if (action.type === "site") {
      const url = SITE_SHORTCUTS[action.name];
      if (!url) return { ok: false, error: `unknown site ${action.name}` };
      await shell.openExternal(url);
      return { ok: true, detail: url };
    }
    if (action.type === "app") {
      const command = APP_COMMANDS[action.name];
      if (!command) return { ok: false, error: `unknown app ${action.name}` };
      const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore", shell: false });
      child.unref();
      return { ok: true, detail: action.name };
    }
    if (action.type === "search") {
      const url = `https://www.google.com/search?q=${encodeURIComponent(action.query)}`;
      await shell.openExternal(url);
      return { ok: true, detail: url };
    }
    if (action.type === "system") {
      return runSystemCommand(action);
    }
    return { ok: false, error: "unknown action" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

async function runSystemCommand(action) {
  const name = action.name;
  if (name === "volume-up" || name === "volume-down") {
    const key = name === "volume-up" ? 175 : 174;
    const result = await runPs(`$w = New-Object -ComObject WScript.Shell; 1..5 | ForEach-Object { $w.SendKeys([char]${key}) }`);
    return result.ok ? { ok: true, detail: name.replace("-", " ") } : { ok: false, error: result.error };
  }
  if (name === "mute") {
    const result = await runPs("$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]173)");
    return result.ok ? { ok: true, detail: "mute toggled" } : { ok: false, error: result.error };
  }
  if (name === "lock") {
    const child = spawn("rundll32.exe", ["user32.dll,LockWorkStation"], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, detail: "locking" };
  }
  if (name === "screenshot") {
    const dir = path.join(app.getPath("pictures"), "ZENO Screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${Date.now()}.png`);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
      "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
      "$g = [System.Drawing.Graphics]::FromImage($bmp)",
      "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)",
      `$bmp.Save('${file.replace(/\\/g, "\\\\")}')`
    ].join("; ");
    const result = await runPs(script);
    if (result.ok) {
      shell.showItemInFolder(file);
      return { ok: true, detail: `saved to ${file}` };
    }
    return { ok: false, error: result.error || "screenshot failed" };
  }
  if (name === "recycle") {
    const result = await runPs("Clear-RecycleBin -Force -ErrorAction SilentlyContinue; Write-Output done");
    return result.ok ? { ok: true, detail: "recycle bin emptied" } : { ok: false, error: result.error };
  }
  if (name === "shutdown") {
    const minutes = Math.max(1, Math.min(720, Number(action.minutes) || 1));
    const child = spawn("shutdown.exe", ["/s", "/t", String(minutes * 60)], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, detail: `shutting down in ${minutes} minute${minutes > 1 ? "s" : ""}, say cancel shutdown to stop it` };
  }
  if (name === "cancel-shutdown") {
    const child = spawn("shutdown.exe", ["/a"], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, detail: "shutdown cancelled" };
  }
  return { ok: false, error: `unknown system command ${name}` };
}

ipcMain.handle("ai:credits", async () => {
  const config = loadConfig();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${config.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) return { ok: false };
    return { ok: true, credits: data?.data || null };
  } catch {
    return { ok: false };
  }
});
