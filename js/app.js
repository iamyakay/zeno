(() => {
  let config = null;
  let pendingImage = null;
  let busy = false;

  const $ = (id) => document.getElementById(id);

  async function boot() {
    config = await window.zeno.getConfig();
    document.body.dataset.theme = config.theme || "green";
    $("core-consensus").checked = Boolean(config.consensusEnabled);
    $("chat-consensus").checked = Boolean(config.consensusEnabled);
    $("core-voice").checked = Boolean(config.voiceReplies);
    fillConfigForm();
    greet();
    loadBalance();
  }

  function greet() {
    if (!config.apiKey) {
      addMessage("core-transcript", "zeno", "welcome. before we talk you need a free OpenRouter API key: grab one at openrouter.ai/keys, then paste it in CONFIG and hit save. image generation and app commands already work without it.");
      return;
    }
    const hour = new Date().getHours();
    const part = hour < 5 ? "up late" : hour < 12 ? "good morning" : hour < 18 ? "good afternoon" : "good evening";
    addMessage("core-transcript", "zeno", `${part}, ${config.userName || "operator"}. systems online. talk to me, or try: "open youtube", "search best mechanical keyboards", "generate an image of a cyberpunk city".`);
  }

  function setBusy(next) {
    busy = next;
    $("status-dot").className = `dot ${next ? "busy" : "ok"}`;
    $("status-text").textContent = next ? "WORKING" : "ONLINE";
    window.ZenoGlobe.setMood(next ? "thinking" : "idle");
  }

  function typeInto(el, text, log) {
    const total = text.length;
    if (total < 40) {
      el.textContent = text;
      return;
    }
    let shown = 0;
    const step = Math.max(2, Math.round(total / 160));
    const timer = setInterval(() => {
      shown += step;
      el.textContent = text.slice(0, shown);
      log.scrollTop = log.scrollHeight;
      if (shown >= total) {
        clearInterval(timer);
        el.textContent = text;
      }
    }, 14);
  }

  function addMessage(logId, who, text, imageUrl, meta) {
    const log = $(logId);
    const wrap = document.createElement("div");
    wrap.className = `msg ${who}`;
    const label = document.createElement("div");
    label.className = "who";
    label.textContent = who === "user" ? (config.userName || "YOU").toUpperCase() : "ZENO";
    const body = document.createElement("div");
    body.className = "body";
    if (who === "zeno") {
      typeInto(body, text, log);
    } else {
      body.textContent = text;
    }
    wrap.append(label, body);
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.className = "attach";
      wrap.appendChild(img);
    }
    if (meta) {
      const metaEl = document.createElement("div");
      metaEl.className = "meta";
      metaEl.textContent = meta;
      wrap.appendChild(metaEl);
    }
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return wrap;
  }

  function addThinking(logId) {
    const log = $(logId);
    const row = document.createElement("div");
    row.className = "thinking-row";
    row.innerHTML = "<span></span><span></span><span></span>";
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  function renderAgents(updates) {
    const bar = $("chat-agents");
    bar.classList.add("active");
    for (const update of updates) {
      const key = `agent-${update.model.replace(/[^\w]/g, "_")}${update.judge ? "_judge" : ""}`;
      let chip = document.getElementById(key);
      if (!chip) {
        chip = document.createElement("span");
        chip.id = key;
        chip.className = "agent-chip";
        bar.appendChild(chip);
      }
      const shortName = update.model.split("/").pop().replace(/:free$/, "");
      chip.textContent = `${update.judge ? "JUDGE " : ""}${shortName}`;
      chip.className = `agent-chip ${update.state}`;
    }
  }

  function clearAgents() {
    const bar = $("chat-agents");
    bar.innerHTML = "";
    bar.classList.remove("active");
  }

  const APP_NAMES = new Set(["notepad", "calculator", "calc", "paint", "explorer", "files", "cmd", "terminal"]);
  const SITE_NAMES = new Set(["browser", "google", "youtube", "github", "discord", "spotify", "reddit", "twitter", "x", "twitch", "gmail", "maps", "netflix", "openrouter"]);

  function parseAction(text) {
    const t = text.trim().toLowerCase().replace(/^zeno[,.!\s]+/, "").replace(/[.!?]+$/, "");
    let m = t.match(/^(?:open|launch|start|go to)\s+(?:the\s+|my\s+|a\s+)?(.+)$/);
    if (m) {
      const target = m[1].trim();
      if (/^https?:\/\//.test(target)) return { type: "url", url: target };
      if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(target)) return { type: "url", url: `https://${target}` };
      const word = target.replace(/\s+app$/, "");
      if (APP_NAMES.has(word)) return { type: "app", name: word };
      if (SITE_NAMES.has(word)) return { type: "site", name: word };
      return null;
    }
    m = t.match(/^(?:search|google)\s+(?:for\s+)?(.+)$/);
    if (m) return { type: "search", query: m[1] };
    return null;
  }

  function parseImagePrompt(text) {
    const t = text.trim().replace(/^zeno[,.!\s]+/i, "").replace(/[.!?]+$/, "");
    let m = t.match(/^(?:generate|create|draw|make|paint)\s+(?:me\s+)?(?:an?\s+|some\s+)?(?:image|picture|photo|art|artwork|wallpaper|logo|icon)\s*(?:of|about|showing|with|:)?\s*(.*)$/i);
    if (m) return m[1].trim();
    m = t.match(/^(?:generate|create|draw|make|paint)\s+(?:me\s+)?(?:an?\s+|some\s+)?(.+?)\s+(?:image|picture|photo|art|artwork|wallpaper)$/i);
    if (m) return m[1].trim();
    m = t.match(/^imagine\s+(.+)$/i);
    if (m) return m[1].trim();
    return null;
  }

  function extractJsonAction(text) {
    const match = text.match(/\{[\s\S]*?"action"\s*:\s*"([^"]+)"[\s\S]*?\}/);
    if (!match) return null;
    try {
      const start = text.indexOf(match[0]);
      const parsed = JSON.parse(text.slice(start, start + match[0].length));
      const input = parsed.action_input || parsed.input || parsed.prompt || parsed.query || "";
      return { action: String(parsed.action || "").toLowerCase(), input: String(input) };
    } catch {
      return null;
    }
  }

  async function runAction(logId, action) {
    setBusy(true);
    const result = await window.zeno.runAction(action);
    setBusy(false);
    if (result.ok) {
      const label = action.type === "search" ? `searching for ${action.query}` : `opened ${action.name || action.url}`;
      addMessage(logId, "zeno", `done. ${label}`);
      if ($("core-voice").checked) window.ZenoVoice.speak(`done, ${label}`);
    } else {
      addMessage(logId, "zeno", `couldn't do that: ${result.error}`);
    }
  }

  async function generateImage(logId, prompt) {
    setBusy(true);
    const thinkingRow = addThinking(logId);
    const result = await window.zeno.genImage(prompt);
    thinkingRow.remove();
    setBusy(false);
    if (result.ok) {
      addMessage(logId, "zeno", `here you go: ${prompt}`, result.dataUrl, "image generator");
      if ($("core-voice").checked) window.ZenoVoice.speak("image ready");
    } else {
      addMessage(logId, "zeno", `image generation failed: ${result.error}`);
    }
  }

  async function submit(logId, text, useConsensus) {
    if (busy) return;
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) return;

    if (logId === "core-transcript") openDock();
    addMessage(logId, "user", trimmed || "[image]", pendingImage);

    if (!pendingImage && trimmed) {
      const action = parseAction(trimmed);
      if (action) {
        return runAction(logId, action);
      }
      const imagePrompt = parseImagePrompt(trimmed);
      if (imagePrompt) {
        return generateImage(logId, imagePrompt);
      }
      if (imagePrompt === "") {
        addMessage(logId, "zeno", "tell me what to draw, like: generate an image of a neon city at night");
        return;
      }
    }

    const image = pendingImage;
    clearImage();
    setBusy(true);
    clearAgents();
    const thinkingRow = addThinking(logId);

    const ask = useConsensus ? window.ZenoEngine.askConsensus : window.ZenoEngine.askSingle;
    const result = await ask(config, trimmed, image, renderAgents);

    thinkingRow.remove();
    setBusy(false);

    if (!result.ok) {
      addMessage(logId, "zeno", `error: ${result.error}`, null, `model: ${result.model}`);
      $("status-dot").className = "dot err";
      setTimeout(() => { if (!busy) $("status-dot").className = "dot ok"; }, 3000);
      return;
    }

    const jsonAction = extractJsonAction(result.text);
    if (jsonAction && jsonAction.input) {
      if (/image|picture|draw|art|photo/.test(jsonAction.action)) {
        return generateImage(logId, jsonAction.input);
      }
      if (/search|google/.test(jsonAction.action)) {
        return runAction(logId, { type: "search", query: jsonAction.input });
      }
      if (/open|browse|navigate|url/.test(jsonAction.action) && /^https?:\/\//.test(jsonAction.input.trim())) {
        return runAction(logId, { type: "url", url: jsonAction.input.trim() });
      }
    }

    let meta = result.model;
    if (result.consensus) {
      meta = `consensus of ${result.consensus.agreed}/${result.consensus.total}: ${result.consensus.sources.map((s) => s.split("/").pop().replace(/:free$/, "")).join(", ")}`;
    }
    addMessage(logId, "zeno", result.text, null, meta);

    if ($("core-voice").checked) {
      window.ZenoVoice.speak(result.text);
    }
  }

  function clearImage() {
    pendingImage = null;
    $("core-attach-name").textContent = "";
    $("chat-attach-name").textContent = "";
    $("image-file").value = "";
  }

  $("image-file").addEventListener("change", () => {
    const file = $("image-file").files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      alert("image too big, keep it under 8 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingImage = reader.result;
      const label = `attached: ${file.name}`;
      $("core-attach-name").textContent = label;
      $("chat-attach-name").textContent = label;
    };
    reader.readAsDataURL(file);
  });

  $("core-image-btn").addEventListener("click", () => $("image-file").click());
  $("chat-image-btn").addEventListener("click", () => $("image-file").click());

  $("dock-handle").addEventListener("click", () => {
    $("core-dock").classList.toggle("collapsed");
  });

  $("dock-expand").addEventListener("click", () => {
    const tall = $("core-dock").classList.toggle("tall");
    $("dock-expand").textContent = tall ? "shrink" : "expand";
  });

  function openDock() {
    $("core-dock").classList.remove("collapsed");
  }

  $("core-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $("core-input").value;
    $("core-input").value = "";
    submit("core-transcript", value, $("core-consensus").checked);
  });

  $("chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $("chat-input").value;
    $("chat-input").value = "";
    submit("chat-log", value, $("chat-consensus").checked);
  });

  $("chat-clear").addEventListener("click", () => {
    $("chat-log").innerHTML = "";
    window.ZenoEngine.clearHistory();
    clearAgents();
  });

  async function startVoice(targetInput, micBtn, logId, consensusToggle) {
    window.ZenoVoice.stopSpeaking();
    if (window.ZenoVoice.listening) {
      window.ZenoVoice.stopListening();
      return;
    }
    window.ZenoGlobe.setMood("listening");
    micBtn.classList.add("live");
    const started = await window.ZenoVoice.startListening(
      (text, isFinal) => {
        if (isFinal) {
          micBtn.classList.remove("live");
          window.ZenoGlobe.setMood("idle");
          targetInput.value = "";
          submit(logId, text, consensusToggle.checked);
        } else {
          targetInput.value = text;
        }
      },
      (error) => {
        micBtn.classList.remove("live");
        if (!busy) window.ZenoGlobe.setMood("idle");
        if (error) addMessage(logId, "zeno", error);
      }
    );
    if (!started) {
      micBtn.classList.remove("live");
      if (!busy) window.ZenoGlobe.setMood("idle");
    }
  }

  $("core-mic-btn").addEventListener("click", () => {
    startVoice($("core-input"), $("core-mic-btn"), "core-transcript", $("core-consensus"));
  });

  $("chat-mic-btn").addEventListener("click", () => {
    startVoice($("chat-input"), $("chat-mic-btn"), "chat-log", $("chat-consensus"));
  });

  window.ZenoGlobe.onClick(() => {
    if (busy) return;
    startVoice($("core-input"), $("core-mic-btn"), "core-transcript", $("core-consensus"));
  });

  function closeSidebar() {
    document.body.classList.remove("nav-open");
  }

  $("nav-toggle").addEventListener("click", () => {
    document.body.classList.toggle("nav-open");
  });

  $("sidebar-veil").addEventListener("click", closeSidebar);

  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      $(`view-${btn.dataset.view}`).classList.add("active");
      closeSidebar();
    });
  }

  function fillConfigForm() {
    $("cfg-key").value = config.apiKey || "";
    $("cfg-base").value = config.baseUrl || "";
    $("cfg-model").value = config.primaryModel || "";
    $("cfg-vision").value = config.visionModel || "";
    $("cfg-judge").value = config.judgeModel || "";
    $("cfg-squad").value = (config.consensusModels || []).join("\n");
    $("cfg-theme").value = config.theme || "green";
    $("cfg-name").value = config.userName || "";
    $("cfg-voice").checked = Boolean(config.voiceReplies);
    $("cfg-consensus").checked = Boolean(config.consensusEnabled);
  }

  $("cfg-save").addEventListener("click", async () => {
    config = await window.zeno.setConfig({
      apiKey: $("cfg-key").value.trim(),
      baseUrl: $("cfg-base").value.trim() || "https://openrouter.ai/api/v1",
      primaryModel: $("cfg-model").value.trim(),
      visionModel: $("cfg-vision").value.trim() || $("cfg-model").value.trim(),
      judgeModel: $("cfg-judge").value.trim() || $("cfg-model").value.trim(),
      consensusModels: $("cfg-squad").value.split("\n").map((s) => s.trim()).filter(Boolean),
      theme: $("cfg-theme").value,
      userName: $("cfg-name").value.trim() || "operator",
      voiceReplies: $("cfg-voice").checked,
      consensusEnabled: $("cfg-consensus").checked
    });
    document.body.dataset.theme = config.theme;
    $("core-consensus").checked = config.consensusEnabled;
    $("chat-consensus").checked = config.consensusEnabled;
    $("core-voice").checked = config.voiceReplies;
    $("cfg-saved").textContent = "saved";
    setTimeout(() => { $("cfg-saved").textContent = ""; }, 2000);
  });

  $("cfg-test").addEventListener("click", async () => {
    $("cfg-test-result").textContent = "testing...";
    await window.zeno.setConfig({ apiKey: $("cfg-key").value.trim(), baseUrl: $("cfg-base").value.trim() || "https://openrouter.ai/api/v1" });
    const result = await window.zeno.chat({
      model: $("cfg-model").value.trim() || config.primaryModel,
      messages: [{ role: "user", content: "reply with exactly: ok" }],
      maxTokens: 10
    });
    $("cfg-test-result").textContent = result.ok ? "connection ok" : `failed: ${result.error}`;
  });

  $("cfg-refresh-models").addEventListener("click", async () => {
    $("cfg-models-count").textContent = "loading...";
    const result = await window.zeno.listModels();
    if (!result.ok) {
      $("cfg-models-count").textContent = `failed: ${result.error}`;
      return;
    }
    const list = $("model-list");
    list.innerHTML = "";
    for (const model of result.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.label = `${model.free ? "[free] " : ""}${model.vision ? "[vision] " : ""}${model.name}`;
      list.appendChild(option);
    }
    const freeCount = result.models.filter((m) => m.free).length;
    $("cfg-models-count").textContent = `${result.models.length} models loaded, ${freeCount} free`;
  });

  async function loadBalance() {
    const result = await window.zeno.getCredits();
    if (result.ok && result.credits) {
      const used = Number(result.credits.total_usage || 0).toFixed(4);
      const bought = Number(result.credits.total_credits || 0).toFixed(2);
      $("credits-balance").textContent = `openrouter account: $${used} used of $${bought} credits`;
    }
  }

  for (const btn of document.querySelectorAll(".link-btn")) {
    btn.addEventListener("click", async () => {
      if (btn.dataset.url) {
        window.zeno.openExternal(btn.dataset.url);
      } else if (btn.dataset.copy) {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const original = btn.textContent;
        btn.textContent = "copied!";
        setTimeout(() => { btn.textContent = original; }, 1500);
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.ZenoVoice.stopSpeaking();
      window.ZenoVoice.stopListening();
      closeSidebar();
    }
  });

  boot();
})();
