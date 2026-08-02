const { app, shell, clipboard, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

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

const WAKE_SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine",
  "$rec.SetInputToDefaultAudioDevice()",
  "$choices = New-Object System.Speech.Recognition.Choices(@('hey zeno', 'zeno', 'okay zeno', 'hi zeno', 'yo zeno'))",
  "$gb = New-Object System.Speech.Recognition.GrammarBuilder",
  "$gb.Append($choices)",
  "$rec.LoadGrammar((New-Object System.Speech.Recognition.Grammar($gb)))",
  "while ($true) { $r = $rec.Recognize(); if ($r -and $r.Confidence -gt 0.7) { Write-Output 'WAKE'; [Console]::Out.Flush() } }"
].join("; ");

const LISTEN_SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$culture = [System.Globalization.CultureInfo]'en-US'",
  "try { $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture) } catch { $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine }",
  "try { $rec.SetInputToDefaultAudioDevice() } catch { [Console]::WriteLine('NOMIC'); exit }",
  "$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))",
  "$rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5)",
  "$rec.BabbleTimeout = [TimeSpan]::FromSeconds(4)",
  "$rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.7)",
  "$rec.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(0.9)",
  "$state = [hashtable]::Synchronized(@{ h = '' })",
  "$hyp = { param($s, $e) if ($e.Result.Text) { $state.h = $e.Result.Text; [Console]::WriteLine('PARTIAL:' + $e.Result.Text) } }.GetNewClosure()",
  "$rec.add_SpeechHypothesized($hyp)",
  "[Console]::WriteLine('READY')",
  "$result = $rec.Recognize([TimeSpan]::FromSeconds(12))",
  "if ($result -and $result.Text) { [Console]::WriteLine('FINAL:' + $result.Text) }",
  "elseif ($state.h) { [Console]::WriteLine('FINAL:' + $state.h) }"
].join("; ");

let wakeChild = null;
let wakeEnabled = false;
let listenChild = null;
let getWin = () => null;

function startWake() {
  if (wakeChild || !wakeEnabled) return;
  try {
    wakeChild = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WAKE_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } catch {
    wakeChild = null;
    return;
  }
  wakeChild.stdout.on("data", (chunk) => {
    const win = getWin();
    if (chunk.toString().includes("WAKE") && win && !win.isDestroyed()) {
      win.webContents.send("zeno:wake");
    }
  });
  wakeChild.on("close", () => {
    wakeChild = null;
    if (wakeEnabled) setTimeout(startWake, 1500);
  });
}

function stopWake() {
  if (wakeChild) {
    const child = wakeChild;
    wakeChild = null;
    try { child.removeAllListeners("close"); child.kill(); } catch {}
  }
}

function setWakeEnabled(enabled) {
  wakeEnabled = Boolean(enabled);
  if (wakeEnabled) startWake();
  else stopWake();
}

function shutdown() {
  wakeEnabled = false;
  stopWake();
  if (listenChild) {
    try { listenChild.kill(); } catch {}
    listenChild = null;
  }
}

function listen() {
  return new Promise((resolve) => {
    stopWake();
    if (listenChild) {
      try { listenChild.kill(); } catch {}
      listenChild = null;
    }
    let buffer = "";
    let finalText = "";
    let lastPartial = "";
    let noMic = false;
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
    }, 16000);
    listenChild.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith("PARTIAL:")) {
          lastPartial = line.slice(8);
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send("zeno:listen-partial", lastPartial);
          }
        } else if (line.startsWith("FINAL:")) {
          finalText = line.slice(6);
        } else if (line.startsWith("NOMIC")) {
          noMic = true;
        }
      }
    });
    listenChild.on("error", (error) => {
      clearTimeout(killTimer);
      finish({ ok: false, error: String(error?.message || error) });
    });
    listenChild.on("close", () => {
      clearTimeout(killTimer);
      if (wakeEnabled) setTimeout(startWake, 500);
      const text = (finalText || lastPartial).trim();
      if (text) {
        finish({ ok: true, text });
      } else if (noMic) {
        finish({ ok: false, error: "no microphone found. plug one in or pick a default mic in Windows sound settings" });
      } else {
        finish({ ok: false, error: "didn't catch anything. speak right after the ring turns red, close to the mic" });
      }
    });
  });
}

const SCREENSHOT_SCRIPT = (file) => [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
  "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
  "$g = [System.Drawing.Graphics]::FromImage($bmp)",
  "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)",
  `$bmp.Save('${file.replace(/\\/g, "\\\\")}')`
].join("; ");

async function screenLook() {
  const file = path.join(app.getPath("temp"), `zeno-look-${Date.now()}.png`);
  const win = getWin();
  const wasVisible = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  if (wasVisible) win.minimize();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await runPs(SCREENSHOT_SCRIPT(file));
  if (wasVisible) win.restore();
  if (!result.ok) return { ok: false, error: result.error || "capture failed" };
  try {
    const buffer = fs.readFileSync(file);
    fs.unlinkSync(file);
    return { ok: true, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

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
    const result = await runPs(SCREENSHOT_SCRIPT(file));
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
  if (name === "restart") {
    const child = spawn("shutdown.exe", ["/r", "/t", "30"], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, detail: "restarting in 30 seconds, say cancel shutdown to stop it" };
  }
  if (name === "sleep") {
    const child = spawn("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, detail: "going to sleep" };
  }
  if (name === "brightness") {
    const level = Math.max(5, Math.min(100, Number(action.level) || 70));
    const result = await runPs(`(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${level})`);
    return result.ok
      ? { ok: true, detail: `brightness set to ${level}%` }
      : { ok: false, error: "couldn't set brightness, this might be an external monitor" };
  }
  if (name === "battery") {
    const result = await runPs("$b = Get-WmiObject Win32_Battery; if ($b) { Write-Output \"$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)\" } else { Write-Output 'none' }");
    if (!result.ok) return { ok: false, error: result.error };
    if (result.output === "none") return { ok: true, detail: "no battery found, this looks like a desktop" };
    const [pct, status] = result.output.split("|");
    const charging = status === "2" ? "plugged in and charging" : "running on battery";
    return { ok: true, detail: `battery at ${pct}%, ${charging}` };
  }
  if (name === "media") {
    const keys = { "play-pause": 179, next: 176, previous: 177, stop: 178 };
    const code = keys[action.key];
    if (!code) return { ok: false, error: "unknown media key" };
    const result = await runPs(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]${code})`);
    return result.ok ? { ok: true, detail: action.key.replace("-", " ") } : { ok: false, error: result.error };
  }
  if (name === "kill") {
    const target = String(action.target || "").toLowerCase().replace(/[^a-z0-9_. -]/g, "").trim();
    if (!target) return { ok: false, error: "which app?" };
    const protectedProcs = new Set(["system", "csrss", "winlogon", "lsass", "svchost", "wininit", "services", "smss", "dwm", "explorer", "zeno", "electron"]);
    if (protectedProcs.has(target.replace(/\.exe$/, ""))) {
      return { ok: false, error: `not touching ${target}, that one matters` };
    }
    const image = target.endsWith(".exe") ? target : `${target}.exe`;
    const result = await runPs(`taskkill /IM '${image}' /F 2>&1 | Out-String`);
    if (result.output.includes("SUCCESS")) return { ok: true, detail: `closed ${target}` };
    return { ok: false, error: `couldn't find a running app called ${target}` };
  }
  if (name === "processes") {
    const result = await runPs("Get-Process | Sort-Object WS -Descending | Select-Object -First 6 | ForEach-Object { \"$($_.ProcessName) $([math]::Round($_.WS / 1MB)) MB\" }");
    if (!result.ok || !result.output) return { ok: false, error: "couldn't read the process list" };
    return { ok: true, detail: `heaviest right now: ${result.output.split(/\r?\n/).join(", ")}` };
  }
  if (name === "settings-page") {
    const pages = {
      bluetooth: "ms-settings:bluetooth",
      wifi: "ms-settings:network-wifi",
      network: "ms-settings:network",
      display: "ms-settings:display",
      sound: "ms-settings:sound",
      battery: "ms-settings:batterysaver",
      apps: "ms-settings:appsfeatures",
      updates: "ms-settings:windowsupdate"
    };
    const uri = pages[action.page];
    if (!uri) return { ok: false, error: `no settings page for ${action.page}` };
    const child = spawn("cmd.exe", ["/c", "start", "", uri], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, detail: `opened ${action.page} settings` };
  }
  if (name === "type") {
    const raw = String(action.text || "").slice(0, 400);
    if (!raw) return { ok: false, error: "type what?" };
    const escaped = raw.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/'/g, "''");
    const result = await runPs(`Start-Sleep -Seconds 3; $w = New-Object -ComObject WScript.Shell; $w.SendKeys('${escaped}')`, 30000);
    return result.ok
      ? { ok: true, detail: "typed it, hope the right window was focused" }
      : { ok: false, error: result.error };
  }
  return { ok: false, error: `unknown system command ${name}` };
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

const FOLDER_NAMES = new Set(["downloads", "documents", "pictures", "music", "videos", "desktop", "home"]);

async function runAction(action) {
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
    if (action.type === "folder") {
      if (!FOLDER_NAMES.has(action.name)) return { ok: false, error: `unknown folder ${action.name}` };
      const folder = app.getPath(action.name);
      const child = spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true, detail: folder };
    }
    return { ok: false, error: "unknown action" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

let lastCpuSnapshot = null;
let cachedDisk = null;
let cachedDiskAt = 0;

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const key of Object.keys(cpu.times)) total += cpu.times[key];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

async function getStats() {
  const snap = cpuSnapshot();
  let cpu = 0;
  if (lastCpuSnapshot) {
    const dTotal = snap.total - lastCpuSnapshot.total;
    const dIdle = snap.idle - lastCpuSnapshot.idle;
    cpu = dTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100))) : 0;
  }
  lastCpuSnapshot = snap;

  if (!cachedDisk || Date.now() - cachedDiskAt > 60000) {
    const result = await runPs("$d = Get-PSDrive C; Write-Output \"$($d.Used)|$($d.Free)\"", 8000);
    if (result.ok && result.output.includes("|")) {
      const [used, free] = result.output.split("|").map(Number);
      if (Number.isFinite(used) && Number.isFinite(free)) {
        cachedDisk = { usedGb: used / 1073741824, totalGb: (used + free) / 1073741824 };
        cachedDiskAt = Date.now();
      }
    }
  }

  return {
    cpu,
    memUsedGb: (os.totalmem() - os.freemem()) / 1073741824,
    memTotalGb: os.totalmem() / 1073741824,
    disk: cachedDisk,
    uptimeSec: Math.round(os.uptime())
  };
}

function register(ipcMain, windowGetter) {
  getWin = windowGetter;
  ipcMain.handle("os:listen", () => listen());
  ipcMain.handle("os:listen-cancel", () => {
    if (listenChild) {
      try { listenChild.kill(); } catch {}
      listenChild = null;
    }
    return true;
  });
  ipcMain.handle("os:action", (_event, action) => runAction(action));
  ipcMain.handle("os:stats", () => getStats());
  ipcMain.handle("os:screen-look", () => screenLook());
  ipcMain.handle("os:clipboard-read", () => clipboard.readText());
  ipcMain.handle("os:clipboard-write", (_event, text) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });
}

module.exports = { register, runPs, setWakeEnabled, shutdown };
