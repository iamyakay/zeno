const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const BIN_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const MODEL_SIZE = 147964211;

let setupPromise = null;
let ready = false;

function dir() {
  return path.join(app.getPath("userData"), "whisper");
}

function exePath() {
  return path.join(dir(), "whisper-cli.exe");
}

function modelPath() {
  return path.join(dir(), "ggml-base.en.bin");
}

function isReady() {
  if (ready) return true;
  try {
    ready = fs.existsSync(exePath()) && fs.statSync(modelPath()).size > MODEL_SIZE * 0.95;
  } catch {
    ready = false;
  }
  return ready;
}

async function download(url, dest, onProgress) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") || 0);
  const file = fs.createWriteStream(dest);
  const reader = response.body.getReader();
  let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (total && onProgress) onProgress(got / total);
    await new Promise((resolve, reject) => file.write(Buffer.from(value), (err) => err ? reject(err) : resolve()));
  }
  await new Promise((resolve) => file.end(resolve));
}

function unzip(zipFile, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let err = "";
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(err || `unzip exit ${code}`)));
    child.on("error", reject);
  });
}

function findFile(root, name) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name) {
      return full;
    }
  }
  return null;
}

async function setup(onStatus) {
  if (isReady()) return true;
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    const target = dir();
    fs.mkdirSync(target, { recursive: true });
    if (!fs.existsSync(exePath())) {
      onStatus?.("downloading speech engine...");
      const zip = path.join(target, "whisper.zip");
      await download(BIN_URL, zip);
      onStatus?.("unpacking speech engine...");
      const extracted = path.join(target, "extracted");
      await unzip(zip, extracted);
      const cli = findFile(extracted, "whisper-cli.exe") || findFile(extracted, "main.exe");
      if (!cli) throw new Error("whisper-cli.exe not found in archive");
      const cliDir = path.dirname(cli);
      for (const file of fs.readdirSync(cliDir)) {
        if (/\.(exe|dll)$/i.test(file)) {
          fs.copyFileSync(path.join(cliDir, file), path.join(target, file === path.basename(cli) ? "whisper-cli.exe" : file));
        }
      }
      fs.rmSync(extracted, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
    }
    if (!fs.existsSync(modelPath()) || fs.statSync(modelPath()).size < MODEL_SIZE * 0.95) {
      onStatus?.("downloading speech model (140 MB, one time)...");
      await download(MODEL_URL, modelPath(), (p) => {
        onStatus?.(`downloading speech model... ${Math.round(p * 100)}%`);
      });
    }
    ready = false;
    if (!isReady()) throw new Error("setup finished but files are missing");
    onStatus?.("speech engine ready");
    return true;
  })();
  try {
    return await setupPromise;
  } finally {
    setupPromise = null;
  }
}

function transcribe(wavBuffer) {
  return new Promise((resolve) => {
    if (!isReady()) {
      resolve({ ok: false, error: "whisper not ready" });
      return;
    }
    const wavFile = path.join(app.getPath("temp"), `zeno-speech-${Date.now()}.wav`);
    try {
      fs.writeFileSync(wavFile, Buffer.from(wavBuffer));
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
      return;
    }
    let out = "";
    let child;
    try {
      child = spawn(exePath(), [
        "-m", modelPath(),
        "-f", wavFile,
        "-l", "en",
        "-t", String(Math.max(2, Math.min(8, require("node:os").cpus().length - 2))),
        "-bs", "3",
        "-nt",
        "-sns",
        "--no-prints",
        "--prompt", "ZENO, my desktop assistant. Commands like: open youtube, volume up, make a file."
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      fs.rmSync(wavFile, { force: true });
      resolve({ ok: false, error: String(error?.message || error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      fs.rmSync(wavFile, { force: true });
      resolve({ ok: false, error: String(error?.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(wavFile, { force: true });
      const text = out
        .replace(/\[[\d:. >-]+\]/g, " ")
        .replace(/\((?:speaking in foreign language|inaudible|music|noise)[^)]*\)/gi, " ")
        .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE)[^\]]*\]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (code !== 0) {
        resolve({ ok: false, error: `whisper exit ${code}` });
      } else {
        resolve({ ok: true, text });
      }
    });
  });
}

function register(ipcMain, windowGetter) {
  ipcMain.handle("whisper:ready", () => isReady());
  ipcMain.handle("whisper:setup", (event) => {
    return setup((status) => {
      if (!event.sender.isDestroyed()) event.sender.send("whisper:status", status);
    }).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  });
  ipcMain.handle("whisper:transcribe", (_event, wavBuffer) => transcribe(wavBuffer));
}

module.exports = { register, isReady, setup };
