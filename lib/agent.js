const { app, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const config = require("./config");

const MAX_STEPS = 14;
const MAX_OUTPUT = 6000;

const BLOCKED = [
  /format\s+[a-z]:/i,
  /remove-item\s+.*(c:\\windows|c:\\users\s|\$env:windir|\/s\s+c:\\)/i,
  /rd\s+\/s\s+\/q\s+c:\\/i,
  /del\s+\/f\s+\/s\s+\/q\s+c:\\/i,
  /reg\s+delete\s+hklm/i,
  /vssadmin\s+delete/i,
  /cipher\s+\/w/i,
  /diskpart/i,
  /bcdedit/i,
  /takeown\s+\/f\s+c:\\windows/i
];

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
        cwd: cwd || os.homedir(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, output: String(error?.message || error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs || 60000);
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(error?.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = (out + (err ? `\n${err}` : "")).trim();
      resolve({ ok: code === 0, output: combined.slice(0, MAX_OUTPUT) || `(no output, exit code ${code})` });
    });
  });
}

function safePath(raw) {
  const resolved = path.resolve(String(raw || "").replace(/^~($|[\\/])/, `${os.homedir()}$1`));
  const lowered = resolved.toLowerCase();
  const windir = (process.env.WINDIR || "C:\\Windows").toLowerCase();
  if (lowered.startsWith(windir)) return null;
  if (/\\appdata\\.*\\(zeno-config\.json|zeno-memory\.json)$/i.test(lowered)) return null;
  return resolved;
}

const tools = {
  async run(input) {
    const command = String(input.command || "");
    if (!command.trim()) return "error: empty command";
    for (const pattern of BLOCKED) {
      if (pattern.test(command)) return "error: that command is blocked for safety, tell the user why you cannot run it";
    }
    const result = await runShell(command, input.cwd ? safePath(input.cwd) : null, Math.min(180000, Number(input.timeout_sec || 60) * 1000));
    return `exit ${result.ok ? "ok" : "error"}\n${result.output}`;
  },
  async write_file(input) {
    const file = safePath(input.path);
    if (!file) return "error: that path is protected";
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(input.content ?? ""), "utf8");
      return `wrote ${Buffer.byteLength(String(input.content ?? ""), "utf8")} bytes to ${file}`;
    } catch (error) {
      return `error: ${String(error?.message || error)}`;
    }
  },
  async append_file(input) {
    const file = safePath(input.path);
    if (!file) return "error: that path is protected";
    try {
      fs.appendFileSync(file, String(input.content ?? ""), "utf8");
      return `appended to ${file}`;
    } catch (error) {
      return `error: ${String(error?.message || error)}`;
    }
  },
  async read_file(input) {
    const file = safePath(input.path);
    if (!file) return "error: that path is protected";
    try {
      const stat = fs.statSync(file);
      if (stat.size > 400000) return `error: file is ${Math.round(stat.size / 1024)} KB, too big, read a portion with run + Get-Content`;
      return fs.readFileSync(file, "utf8").slice(0, MAX_OUTPUT);
    } catch (error) {
      return `error: ${String(error?.message || error)}`;
    }
  },
  async list_dir(input) {
    const dir = safePath(input.path || os.homedir());
    if (!dir) return "error: that path is protected";
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200);
      return entries.map((e) => `${e.isDirectory() ? "[dir] " : ""}${e.name}`).join("\n") || "(empty)";
    } catch (error) {
      return `error: ${String(error?.message || error)}`;
    }
  },
  async open(input) {
    const target = String(input.target || "");
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target);
      return `opened ${target}`;
    }
    const file = safePath(target);
    if (!file) return "error: that path is protected";
    const outcome = await shell.openPath(file);
    return outcome ? `error: ${outcome}` : `opened ${file}`;
  }
};

function agentSystemPrompt(cfg) {
  return [
    `You are ZENO Agent, ${cfg.userName || "the user"}'s hands on their Windows PC. Today is ${new Date().toDateString()}. Home folder: ${os.homedir()}.`,
    "You complete real tasks by calling tools. You can create coding projects, write and edit files, run and test programs, install packages, start servers, manage processes and folders.",
    "Reply with EXACTLY ONE JSON object per turn and nothing else. No markdown fences, no prose outside the JSON.",
    'Tool call: {"tool": "<name>", "input": {...}, "note": "<short present-tense status shown to the user, like: creating index.html>"}',
    "Available tools:",
    'run: execute a PowerShell command. input: {"command": "...", "cwd": "optional working dir", "timeout_sec": 60}. Use ; instead of && to chain. For servers or long-running programs use Start-Process so you do not hang.',
    'write_file: create or overwrite a file. input: {"path": "...", "content": "..."}',
    'append_file: append to a file. input: {"path": "...", "content": "..."}',
    'read_file: read a text file. input: {"path": "..."}',
    'list_dir: list a folder. input: {"path": "..."}',
    'open: open a file, folder or url with the default app. input: {"target": "..."}',
    'When the task is complete reply: {"tool": "final", "input": {"answer": "<what you did, where the files are, how to run it>"}}',
    "Rules: prefer write_file over echo for file content. Test what you build with run when practical. If a command fails, read the error and fix it, do not repeat the same command. Never run destructive commands on system folders. Keep the whole task under " + MAX_STEPS + " steps."
  ].join("\n");
}

function extractJson(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  for (let end = trimmed.length; end > start; end -= 1) {
    const candidate = trimmed.slice(start, end);
    if (!candidate.endsWith("}")) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

async function callModel(cfg, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        "HTTP-Referer": "https://teamzap.uk",
        "X-Title": "ZENO"
      },
      body: JSON.stringify({ model: cfg.primaryModel, messages, max_tokens: 4000, temperature: 0.2 }),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, error: data?.error?.message || `HTTP ${response.status}` };
    let text = data?.choices?.[0]?.message?.content ?? "";
    if (Array.isArray(text)) text = text.map((p) => p?.text || "").join("");
    text = String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return { ok: true, text, usage: data?.usage || null };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "request timed out" : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

let cancelled = false;

async function runTask(task, sendStep) {
  cancelled = false;
  const cfg = config.load();
  if (!cfg.apiKey) return { ok: false, error: "agent mode needs an API key, set one in CONFIG" };
  const messages = [
    { role: "system", content: agentSystemPrompt(cfg) },
    { role: "user", content: String(task) }
  ];
  let totalTokens = 0;
  const actions = [];
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    if (cancelled) return { ok: false, error: "agent task cancelled", steps: actions, tokens: totalTokens };
    const reply = await callModel(cfg, messages);
    if (!reply.ok) return { ok: false, error: reply.error, steps: actions, tokens: totalTokens };
    totalTokens += Number(reply.usage?.total_tokens || 0);
    const call = extractJson(reply.text);
    if (!call || !call.tool) {
      return { ok: true, answer: reply.text, steps: actions, tokens: totalTokens };
    }
    if (call.tool === "final") {
      return { ok: true, answer: String(call.input?.answer || "done"), steps: actions, tokens: totalTokens };
    }
    const tool = tools[call.tool];
    const note = String(call.note || `${call.tool}...`).slice(0, 140);
    sendStep({ step, tool: call.tool, note, state: "working" });
    let observation;
    if (!tool) {
      observation = `error: unknown tool ${call.tool}, valid tools: run, write_file, append_file, read_file, list_dir, open, final`;
    } else {
      observation = await tool(call.input || {});
    }
    const failed = observation.startsWith("error:") || observation.startsWith("exit error");
    actions.push({ tool: call.tool, note, ok: !failed });
    sendStep({ step, tool: call.tool, note, state: failed ? "failed" : "done" });
    messages.push({ role: "assistant", content: reply.text });
    messages.push({ role: "user", content: `Tool result:\n${observation}` });
  }
  return { ok: true, answer: "I hit the step limit before finishing. Here is where things stand, ask me to continue if needed.", steps: actions, tokens: totalTokens };
}

function register(ipcMain) {
  ipcMain.handle("agent:run", (event, task) => {
    return runTask(task, (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send("agent:step", payload);
    });
  });
  ipcMain.handle("agent:cancel", () => {
    cancelled = true;
    return true;
  });
}

module.exports = { register };
