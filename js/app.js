(() => {
  let config = null;
  let pendingImage = null;
  let busy = false;
  let session = null;
  let saveTimer = null;
  let lastZenoReply = null;

  const $ = (id) => document.getElementById(id);

  function newSession() {
    session = { id: `s${Date.now()}`, title: "", at: new Date().toISOString(), messages: [], engineHistory: [] };
  }

  function recordMessage(who, text, meta) {
    if (!session) newSession();
    if (!session.title && who === "user") session.title = text.slice(0, 60);
    session.messages.push({ who, text: text.slice(0, 8000), meta: meta || null });
    session.engineHistory = window.ZenoEngine.getHistory();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (session.messages.length > 0 && session.title) window.zeno.chatsSave(session);
    }, 600);
  }

  let pluginList = [];
  let docContext = null;
  let sessionTokens = 0;

  function trackTokens(usage) {
    if (!usage) return;
    sessionTokens += Number(usage.total_tokens || 0);
    const el = $("chat-tokens");
    if (el) el.textContent = sessionTokens > 0 ? `session: ${sessionTokens.toLocaleString()} tokens` : "";
  }

  function usageMeta(result) {
    if (!result?.usage) return null;
    const u = result.usage;
    const parts = [`${Number(u.prompt_tokens || 0).toLocaleString()} in`, `${Number(u.completion_tokens || 0).toLocaleString()} out`, `${Number(u.total_tokens || 0).toLocaleString()} total tokens`];
    return `${parts.join(" · ")}${result.deepThink ? " · deep think" : ""}`;
  }

  function activeLog() {
    return document.querySelector("#view-chat.active") ? "chat-log" : "core-transcript";
  }

  const TEXT_FILE = /\.(txt|md|markdown|json|js|ts|jsx|tsx|py|html|css|csv|log|xml|yml|yaml|ini|toml|bat|ps1|sh|c|cpp|h|java|rs|go|sql)$/i;

  document.addEventListener("dragover", (event) => event.preventDefault());

  document.addEventListener("drop", async (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const logId = activeLog();
    if (/^image\//.test(file.type)) {
      if (file.size > 8 * 1024 * 1024) {
        addMessage(logId, "zeno", "image too big, keep it under 8 MB");
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
      return;
    }
    if (!TEXT_FILE.test(file.name)) {
      addMessage(logId, "zeno", "can't read that file type, drop a text file like .txt, .md or code");
      return;
    }
    if (file.size > 400 * 1024) {
      addMessage(logId, "zeno", "file too big, keep it under 400 KB");
      return;
    }
    const text = await file.text();
    docContext = { name: file.name, text: text.slice(0, 80000), used: false };
    const kb = (file.size / 1024).toFixed(0);
    addMessage(logId, "zeno", `loaded ${file.name} (${kb} KB). ask me anything about it, say "clear file" when you're done.`);
  });

  async function bootStep(percent, text) {
    $("boot-bar-fill").style.width = `${percent}%`;
    $("boot-line").textContent = text;
    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  async function boot() {
    await bootStep(15, "loading configuration...");
    config = await window.zeno.getConfig();
    await bootStep(38, "restoring memory...");
    config.memory = await window.zeno.memList();
    await bootStep(58, "linking plugins...");
    try {
      pluginList = (await window.zeno.pluginsList()).map((p) => ({
        ...p,
        regex: new RegExp(p.pattern.source, p.pattern.flags)
      }));
    } catch {
      pluginList = [];
    }
    await bootStep(80, "spinning up the core...");
    document.body.dataset.theme = config.theme || "green";
    $("core-consensus").checked = Boolean(config.consensusEnabled);
    $("chat-consensus").checked = Boolean(config.consensusEnabled);
    $("core-voice").checked = Boolean(config.voiceReplies);
    fillConfigForm();
    greet();
    loadBalance();
    pollStats();
    setInterval(pollStats, 2500);
    refreshTodoPanel();
    setTimeout(checkForUpdates, 4000);
    await bootStep(100, "online");
    $("boot-screen").classList.add("done");
    setTimeout(() => $("boot-screen").remove(), 700);
  }

  function greet() {
    if (!config.apiKey) {
      addMessage("core-transcript", "zeno", "welcome. before we talk you need a free OpenRouter API key: grab one at openrouter.ai/keys, then paste it in CONFIG and hit save. image generation and app commands already work without it.");
      return;
    }
    const hour = new Date().getHours();
    const part = hour < 5 ? "up late" : hour < 12 ? "good morning" : hour < 18 ? "good afternoon" : "good evening";
    addMessage("core-transcript", "zeno", `${part}, ${config.userName || "operator"}. systems online. press ctrl+y anywhere for the quick assistant. try: "open youtube", "make me a snake game in python" with agent mode on, or "generate an image of a cyberpunk city".`);
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

  function attachCopy(wrap, text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-copy";
    btn.textContent = "copy";
    btn.addEventListener("click", async () => {
      await window.zeno.clipboardWrite(text);
      btn.textContent = "copied";
      setTimeout(() => { btn.textContent = "copy"; }, 1400);
    });
    wrap.appendChild(btn);
  }

  function addMessage(logId, who, text, imageUrl, meta) {
    const log = $(logId);
    const wrap = document.createElement("div");
    wrap.className = `msg ${who}`;
    const label = document.createElement("div");
    label.className = "who";
    label.textContent = who === "user" ? (config.userName || "YOU").toUpperCase() : "ZENO";
    if (who === "zeno") lastZenoReply = text;
    const body = document.createElement("div");
    body.className = "body";
    if (who === "zeno" && window.ZenoMd.hasMarkdown(text)) {
      window.ZenoMd.render(body, text);
    } else if (who === "zeno") {
      typeInto(body, text, log);
    } else {
      body.textContent = text;
    }
    wrap.append(label, body);
    if (who === "zeno") attachCopy(wrap, text);
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
    if (!imageUrl || who === "zeno") {
      recordMessage(who, text, meta);
    } else {
      recordMessage(who, text ? `${text} [image attached]` : "[image attached]", meta);
    }
    return wrap;
  }

  function replayMessage(logId, entry) {
    const log = $(logId);
    const wrap = document.createElement("div");
    wrap.className = `msg ${entry.who}`;
    const label = document.createElement("div");
    label.className = "who";
    label.textContent = entry.who === "user" ? (config.userName || "YOU").toUpperCase() : "ZENO";
    const body = document.createElement("div");
    body.className = "body";
    if (entry.who === "zeno" && window.ZenoMd.hasMarkdown(entry.text)) {
      window.ZenoMd.render(body, entry.text);
    } else {
      body.textContent = entry.text;
    }
    wrap.append(label, body);
    if (entry.who === "zeno") attachCopy(wrap, entry.text);
    if (entry.meta) {
      const metaEl = document.createElement("div");
      metaEl.className = "meta";
      metaEl.textContent = entry.meta;
      wrap.appendChild(metaEl);
    }
    log.appendChild(wrap);
  }

  async function renderHistoryList() {
    const list = $("history-list");
    list.innerHTML = "";
    const chats = await window.zeno.chatsList();
    if (chats.length === 0) {
      list.innerHTML = '<p class="hint">no saved conversations yet, go talk to me first</p>';
      return;
    }
    for (const chat of chats.slice().reverse()) {
      const item = document.createElement("div");
      item.className = "history-item";
      const title = document.createElement("span");
      title.className = "h-title";
      title.textContent = chat.title || "untitled";
      const meta = document.createElement("span");
      meta.className = "h-meta";
      meta.textContent = `${chat.count} msgs · ${chat.at.slice(0, 10)}`;
      const del = document.createElement("button");
      del.className = "h-del";
      del.textContent = "delete";
      del.addEventListener("click", async (event) => {
        event.stopPropagation();
        await window.zeno.chatsDelete(chat.id);
        item.remove();
      });
      item.append(title, meta, del);
      item.addEventListener("click", async () => {
        const full = await window.zeno.chatsLoad(chat.id);
        if (!full) return;
        $("chat-log").innerHTML = "";
        session = full;
        window.ZenoEngine.setHistory(full.engineHistory);
        for (const entry of full.messages) replayMessage("chat-log", entry);
        $("chat-log").scrollTop = $("chat-log").scrollHeight;
        switchView("chat");
      });
      list.appendChild(item);
    }
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

  let raceTimer = null;

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
      chip.dataset.name = `${update.judge ? "JUDGE " : ""}${shortName}`;
      if (update.state === "working") {
        chip.dataset.startedAt = String(update.startedAt ?? performance.now());
        chip.textContent = `${chip.dataset.name} · 0.0s`;
      } else {
        const ms = update.ms != null ? ` · ${(update.ms / 1000).toFixed(1)}s` : "";
        chip.textContent = `${chip.dataset.name}${ms}${update.state === "failed" ? " ✗" : ""}`;
      }
      chip.className = `agent-chip ${update.state}`;
    }
    const done = [...bar.querySelectorAll(".agent-chip.done")].filter((c) => !c.id.endsWith("_judge"));
    if (done.length > 0) {
      let fastest = null;
      for (const chip of done) {
        const ms = Number(chip.textContent.match(/([\d.]+)s/)?.[1] || Infinity);
        if (!fastest || ms < Number(fastest.textContent.match(/([\d.]+)s/)?.[1] || Infinity)) fastest = chip;
      }
      bar.querySelectorAll(".agent-chip.fastest").forEach((c) => c.classList.remove("fastest"));
      fastest?.classList.add("fastest");
    }
    if (!raceTimer) {
      raceTimer = setInterval(() => {
        const working = bar.querySelectorAll(".agent-chip.working");
        if (working.length === 0) {
          clearInterval(raceTimer);
          raceTimer = null;
          return;
        }
        for (const chip of working) {
          const elapsed = (performance.now() - Number(chip.dataset.startedAt)) / 1000;
          chip.textContent = `${chip.dataset.name} · ${elapsed.toFixed(1)}s`;
        }
      }, 100);
    }
  }

  function clearAgents() {
    const bar = $("chat-agents");
    bar.innerHTML = "";
    bar.classList.remove("active");
    if (raceTimer) {
      clearInterval(raceTimer);
      raceTimer = null;
    }
  }

  async function runAction(logId, action) {
    setBusy(true);
    const result = await window.zeno.runAction(action);
    setBusy(false);
    if (result.ok) {
      let label;
      if (action.type === "search") label = `searching for ${action.query}`;
      else if (action.type === "system") label = result.detail;
      else label = `opened ${action.name || action.url}`;
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

  let agentStepsEl = null;

  window.zeno.onAgentStep((payload) => {
    if (!agentStepsEl || !agentStepsEl.isConnected) return;
    const key = `agent-step-${payload.step}`;
    let row = document.getElementById(key);
    if (!row) {
      row = document.createElement("div");
      row.id = key;
      row.className = "agent-step";
      agentStepsEl.appendChild(row);
    }
    row.textContent = `${payload.step}. ${payload.note}`;
    row.className = `agent-step ${payload.state}`;
    const log = agentStepsEl.closest("#chat-log, #core-transcript");
    if (log) log.scrollTop = log.scrollHeight;
  });

  async function runAgentTask(logId, task) {
    setBusy(true);
    const log = $(logId);
    agentStepsEl = document.createElement("div");
    agentStepsEl.className = "agent-steps";
    log.appendChild(agentStepsEl);
    log.scrollTop = log.scrollHeight;
    const result = await window.zeno.agentRun(task);
    setBusy(false);
    if (agentStepsEl.children.length === 0) agentStepsEl.remove();
    agentStepsEl = null;
    const tokenNote = result.tokens ? ` · ${Number(result.tokens).toLocaleString()} tokens` : "";
    if (result.ok) {
      addMessage(logId, "zeno", result.answer, null, `agent mode · ${result.steps?.length || 0} steps${tokenNote}`);
      if ($("core-voice").checked) window.ZenoVoice.speak(result.answer);
    } else {
      addMessage(logId, "zeno", `agent failed: ${result.error}`, null, `agent mode${tokenNote}`);
    }
  }

  async function submit(logId, text, useConsensus) {
    if (busy) return;
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) return;

    if (logId === "core-transcript") openDock();
    addMessage(logId, "user", trimmed || "[image]", pendingImage);

    const agentOn = logId === "chat-log" ? $("chat-agent").checked : $("core-agent").checked;
    if (agentOn && trimmed && !pendingImage) {
      return runAgentTask(logId, trimmed);
    }

    if (!pendingImage && trimmed) {
      const lowered = trimmed.toLowerCase().replace(/^zeno[,.!\s]+/, "").replace(/[.!?]+$/, "");
      if (/^(?:system\s+status|status\s+report|how(?:'s| is) the (?:system|pc))$/.test(lowered)) {
        return speakSystemStatus(logId);
      }
      const remember = trimmed.replace(/^zeno[,.!\s]+/i, "").match(/^remember\s+(?:that\s+)?(.+)$/i);
      if (remember) {
        config.memory = await window.zeno.memAdd(remember[1]);
        addMessage(logId, "zeno", "remembered.");
        if ($("core-voice").checked) window.ZenoVoice.speak("remembered");
        return;
      }
      if (/^(?:what\s+do\s+you\s+remember|show\s+(?:your\s+)?memor(?:y|ies)|list\s+memor(?:y|ies))$/.test(lowered)) {
        const memory = config.memory || [];
        if (memory.length === 0) {
          addMessage(logId, "zeno", "nothing yet. tell me: remember <anything>");
        } else {
          addMessage(logId, "zeno", memory.map((m, i) => `${i + 1}. ${m.fact}`).join("\n"));
        }
        return;
      }
      if (/^(?:forget\s+everything|clear\s+(?:your\s+)?memory|wipe\s+memory)$/.test(lowered)) {
        config.memory = await window.zeno.memClear();
        addMessage(logId, "zeno", "memory wiped.");
        return;
      }
      const screenAsk = lowered.match(/^(?:look at|read|check|analyze)\s+(?:my\s+|the\s+)?screen(?:\s+and\s+(.+))?$/) || lowered.match(/^what(?:'s| is) on my screen(?:\s*\?)?$/);
      if (screenAsk) {
        return lookAtScreen(logId, screenAsk[1] || null);
      }
      const clip = lowered.match(/^(summarize|explain|translate|fix|rewrite)\s+(?:my\s+|the\s+)?clipboard(?:\s+(?:to|into|in)\s+(.+))?$/);
      if (clip) {
        const content = await window.zeno.clipboardRead();
        if (!content.trim()) {
          addMessage(logId, "zeno", "your clipboard is empty, copy something first");
          return;
        }
        const prompts = {
          summarize: "Summarize this concisely:",
          explain: "Explain this in simple terms:",
          translate: `Translate this to ${clip[2] || "english"}, reply with only the translation:`,
          fix: "Fix the grammar and spelling, reply with only the corrected text:",
          rewrite: "Rewrite this to read better, reply with only the rewritten text:"
        };
        return askDirect(logId, `${prompts[clip[1]]}\n\n${content.slice(0, 6000)}`, null, `clipboard ${clip[1]}`);
      }
      const todoAdd = lowered.match(/^(?:add\s+(.+?)\s+to\s+(?:my\s+|the\s+)?(?:todo\s+)?list|todo\s+(.+))$/);
      if (todoAdd) {
        await window.zeno.todoAdd(todoAdd[1] || todoAdd[2]);
        refreshTodoPanel();
        addMessage(logId, "zeno", "added to your list.");
        if ($("core-voice").checked) window.ZenoVoice.speak("added");
        return;
      }
      if (/^(?:show\s+|what(?:'s| is)\s+on\s+)(?:my\s+|the\s+)?(?:todo\s+)?list$|^show\s+todos$/.test(lowered)) {
        const todos = await window.zeno.todoList();
        addMessage(logId, "zeno", todos.length === 0 ? "your list is empty" : todos.map((t, i) => `${i + 1}. ${t.text}`).join("\n"));
        return;
      }
      const todoDone = lowered.match(/^(?:done|complete|finished|tick off|check off)\s+(.+?)(?:\s+from\s+(?:my\s+|the\s+)?list)?$/);
      if (todoDone) {
        const result = await window.zeno.todoDone(todoDone[1]);
        refreshTodoPanel();
        addMessage(logId, "zeno", result.removed ? `nice. crossed off: ${result.removed}` : `couldn't find that on your list`);
        return;
      }
      if (/^clear\s+(?:my\s+|the\s+)?(?:todo\s+)?list$/.test(lowered)) {
        await window.zeno.todoClear();
        refreshTodoPanel();
        addMessage(logId, "zeno", "list cleared.");
        return;
      }
      if (/^copy\s+(?:that|last(?:\s+reply)?|reply)$/.test(lowered)) {
        if (lastZenoReply) {
          await window.zeno.clipboardWrite(lastZenoReply);
          addMessage(logId, "zeno", "copied to clipboard.");
        } else {
          addMessage(logId, "zeno", "nothing to copy yet");
        }
        return;
      }
      const weather = lowered.match(/^(?:what(?:'s| is) the )?weather(?: like)?(?: (?:in|at|for) (.+))?$/);
      if (weather) {
        if (!weather[1]) {
          addMessage(logId, "zeno", "which city? say: weather in tokyo");
          return;
        }
        return reportWeather(logId, weather[1]);
      }
      const timeAsk = lowered.match(/^(?:what(?:'s| is) the )?time(?: (?:in|at) (.+))?$/);
      if (timeAsk) {
        return reportTime(logId, timeAsk[1] || null);
      }
      if (/^(?:clear|unload|forget)\s+(?:the\s+)?file$/.test(lowered)) {
        docContext = null;
        addMessage(logId, "zeno", "file unloaded.");
        return;
      }
      const cleaned = trimmed.replace(/^zeno[,.!\s]+/i, "");
      for (const plugin of pluginList) {
        if (plugin.regex.test(cleaned)) {
          setBusy(true);
          const result = await window.zeno.pluginsRun(plugin.name, cleaned);
          setBusy(false);
          const reply = result.ok ? result.text : `plugin ${plugin.name} failed: ${result.error}`;
          addMessage(logId, "zeno", reply, null, `plugin: ${plugin.name}`);
          if ($("core-voice").checked && result.ok) window.ZenoVoice.speak(result.text);
          return;
        }
      }
      const action = window.ZenoCommands.parseAction(trimmed);
      if (action) {
        return runAction(logId, action);
      }
      const imagePrompt = window.ZenoCommands.parseImagePrompt(trimmed);
      if (imagePrompt) {
        return generateImage(logId, imagePrompt);
      }
      if (imagePrompt === "") {
        addMessage(logId, "zeno", "tell me what to draw, like: generate an image of a neon city at night");
        return;
      }
      if (trimmed.length <= 90 && !/\?\s*$/.test(trimmed) && config.apiKey) {
        setBusy(true);
        const routed = await window.ZenoEngine.interpret(config, cleaned);
        setBusy(false);
        if (routed) {
          if (routed.kind === "action") return runAction(logId, routed.action);
          if (routed.kind === "image") return generateImage(logId, routed.prompt);
          if (routed.kind === "agent") return runAgentTask(logId, routed.task);
        }
      }
    }

    let prompt = trimmed;
    if (docContext && !docContext.used && trimmed) {
      prompt = `The user loaded a file named ${docContext.name}. Its contents:\n\n${docContext.text}\n\nQuestion about it: ${trimmed}`;
      docContext.used = true;
    }

    const image = pendingImage;
    clearImage();
    setBusy(true);
    clearAgents();
    const thinkingRow = addThinking(logId);

    const log = $(logId);
    const live = { wrap: null, body: null, buffer: "" };
    const onDelta = (delta) => {
      if (!live.wrap) {
        thinkingRow.remove();
        live.wrap = document.createElement("div");
        live.wrap.className = "msg zeno";
        const label = document.createElement("div");
        label.className = "who";
        label.textContent = "ZENO";
        live.body = document.createElement("div");
        live.body.className = "body";
        live.wrap.append(label, live.body);
        log.appendChild(live.wrap);
      }
      live.buffer += delta;
      live.body.textContent = live.buffer;
      log.scrollTop = log.scrollHeight;
    };

    let result;
    const deepThink = logId === "chat-log" ? $("chat-deep").checked : $("core-deep").checked;
    if (useConsensus) {
      result = await window.ZenoEngine.askConsensus(config, prompt, image, renderAgents);
    } else {
      result = await window.ZenoEngine.askSingle(config, prompt, image, onDelta, { deepThink });
    }
    trackTokens(result.usage);

    if (thinkingRow.isConnected) thinkingRow.remove();
    setBusy(false);

    if (live.wrap) {
      if (result.ok) {
        lastZenoReply = result.text;
        if (window.ZenoMd.hasMarkdown(result.text)) {
          live.body.textContent = "";
          window.ZenoMd.render(live.body, result.text);
        } else {
          live.body.textContent = result.text;
        }
        const metaEl = document.createElement("div");
        metaEl.className = "meta";
        const usageNote = usageMeta(result);
        metaEl.textContent = usageNote ? `${result.model} · ${usageNote}` : result.model;
        live.wrap.appendChild(metaEl);
        attachCopy(live.wrap, result.text);
        log.scrollTop = log.scrollHeight;
        recordMessage("zeno", result.text, metaEl.textContent);
        if ($("core-voice").checked) window.ZenoVoice.speak(result.text);
        return;
      }
      live.wrap.remove();
    }

    if (!result.ok) {
      addMessage(logId, "zeno", `error: ${result.error}`, null, `model: ${result.model}`);
      $("status-dot").className = "dot err";
      setTimeout(() => { if (!busy) $("status-dot").className = "dot ok"; }, 3000);
      return;
    }

    const jsonAction = window.ZenoCommands.extractJsonAction(result.text);
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
    const usageNote = usageMeta(result);
    if (usageNote) meta = `${meta} · ${usageNote}`;
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
    newSession();
  });

  let voiceTargetInput = null;

  window.zeno.onListenPartial((text) => {
    if (voiceTargetInput && window.ZenoVoice.listening) voiceTargetInput.value = text;
  });

  async function startVoice(targetInput, micBtn, logId, consensusToggle) {
    window.ZenoVoice.stopSpeaking();
    if (window.ZenoVoice.listening) {
      window.ZenoVoice.stopListening();
      return;
    }
    voiceTargetInput = targetInput;
    window.ZenoGlobe.setMood("listening");
    micBtn.classList.add("live");
    const started = await window.ZenoVoice.startListening(
      (text, isFinal, status) => {
        if (isFinal) {
          micBtn.classList.remove("live");
          window.ZenoGlobe.setMood("idle");
          targetInput.value = "";
          targetInput.placeholder = "ask ZENO anything...";
          submit(logId, text, consensusToggle.checked);
        } else if (status) {
          targetInput.value = "";
          targetInput.placeholder = status;
        } else {
          targetInput.value = text;
        }
      },
      (error) => {
        micBtn.classList.remove("live");
        targetInput.placeholder = "ask ZENO anything...";
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

  window.zeno.onWake(() => {
    if (busy || window.ZenoVoice.listening) return;
    window.ZenoVoice.speak("yes?");
    setTimeout(() => {
      startVoice($("core-input"), $("core-mic-btn"), "core-transcript", $("core-consensus"));
    }, 700);
  });

  function closeSidebar() {
    document.body.classList.remove("nav-open");
  }

  $("nav-toggle").addEventListener("click", () => {
    document.body.classList.toggle("nav-open");
  });

  $("sidebar-veil").addEventListener("click", closeSidebar);

  function switchView(name) {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $(`view-${name}`).classList.add("active");
    if (name === "history") renderHistoryList();
    closeSidebar();
  }

  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
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
    $("cfg-wake").checked = Boolean(config.wakeWord);
    $("cfg-persona").value = config.persona || "";
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
      consensusEnabled: $("cfg-consensus").checked,
      wakeWord: $("cfg-wake").checked,
      persona: $("cfg-persona").value.trim()
    });
    config.memory = await window.zeno.memList();
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

  let lastStats = null;

  function formatUptime(sec) {
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  async function pollStats() {
    try {
      const stats = await window.zeno.getStats();
      lastStats = stats;
      $("hud-cpu").textContent = `${stats.cpu}%`;
      $("hud-cpu-bar").style.width = `${stats.cpu}%`;
      $("hud-mem").textContent = `${stats.memUsedGb.toFixed(1)} / ${stats.memTotalGb.toFixed(0)} GB`;
      $("hud-mem-bar").style.width = `${Math.round((stats.memUsedGb / stats.memTotalGb) * 100)}%`;
      if (stats.disk) {
        $("hud-disk").textContent = `${stats.disk.usedGb.toFixed(0)} / ${stats.disk.totalGb.toFixed(0)} GB`;
        $("hud-disk-bar").style.width = `${Math.round((stats.disk.usedGb / stats.disk.totalGb) * 100)}%`;
      }
      $("hud-uptime").textContent = formatUptime(stats.uptimeSec);
    } catch {}
  }

  function speakSystemStatus(logId) {
    if (!lastStats) {
      addMessage(logId, "zeno", "stats aren't loaded yet, give me a second");
      return;
    }
    const s = lastStats;
    const memPct = Math.round((s.memUsedGb / s.memTotalGb) * 100);
    const parts = [
      `cpu at ${s.cpu} percent`,
      `memory ${s.memUsedGb.toFixed(1)} of ${s.memTotalGb.toFixed(0)} gigs, ${memPct} percent`,
      s.disk ? `disk ${s.disk.usedGb.toFixed(0)} of ${s.disk.totalGb.toFixed(0)} gigs used` : null,
      `uptime ${formatUptime(s.uptimeSec)}`
    ].filter(Boolean);
    const text = `system status: ${parts.join(", ")}. all nominal.`;
    addMessage(logId, "zeno", text);
    if ($("core-voice").checked) window.ZenoVoice.speak(text);
  }

  async function refreshTodoPanel() {
    try {
      const todos = await window.zeno.todoList();
      const panel = $("todo-panel");
      const items = $("todo-items");
      items.innerHTML = "";
      if (todos.length === 0) {
        panel.classList.add("off");
        return;
      }
      panel.classList.remove("off");
      for (const todo of todos.slice(0, 7)) {
        const row = document.createElement("div");
        row.className = "todo-row";
        row.textContent = todo.text;
        items.appendChild(row);
      }
      if (todos.length > 7) {
        const row = document.createElement("div");
        row.className = "todo-row";
        row.textContent = `+${todos.length - 7} more`;
        items.appendChild(row);
      }
    } catch {}
  }

  async function askDirect(logId, question, imageDataUrl, meta) {
    setBusy(true);
    const thinkingRow = addThinking(logId);
    const result = await window.ZenoEngine.askSingle(config, question, imageDataUrl);
    thinkingRow.remove();
    setBusy(false);
    if (!result.ok) {
      addMessage(logId, "zeno", `error: ${result.error}`, null, `model: ${result.model}`);
      return;
    }
    addMessage(logId, "zeno", result.text, null, meta || result.model);
    if ($("core-voice").checked) window.ZenoVoice.speak(result.text);
  }

  async function lookAtScreen(logId, question) {
    setBusy(true);
    const shot = await window.zeno.screenLook();
    setBusy(false);
    if (!shot.ok) {
      addMessage(logId, "zeno", `couldn't capture the screen: ${shot.error}`);
      return;
    }
    await askDirect(logId, question || "describe what is on my screen and point out anything important", shot.dataUrl, "screen vision");
  }

  async function reportWeather(logId, city) {
    setBusy(true);
    const thinkingRow = addThinking(logId);
    const wx = await window.zeno.getWeather(city);
    thinkingRow.remove();
    setBusy(false);
    if (!wx.ok) {
      addMessage(logId, "zeno", wx.error);
      return;
    }
    const text = `${wx.place}: ${wx.sky}, ${Math.round(wx.temp)}°C (feels like ${Math.round(wx.feels)}°C), humidity ${wx.humidity}%, wind ${Math.round(wx.wind)} km/h`;
    addMessage(logId, "zeno", text);
    if ($("core-voice").checked) {
      window.ZenoVoice.speak(`${wx.place}. ${wx.sky}, ${Math.round(wx.temp)} degrees, feels like ${Math.round(wx.feels)}`);
    }
  }

  async function reportTime(logId, city) {
    if (!city) {
      const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      addMessage(logId, "zeno", `it's ${now}`);
      if ($("core-voice").checked) window.ZenoVoice.speak(`it's ${now}`);
      return;
    }
    setBusy(true);
    const wx = await window.zeno.getWeather(city);
    setBusy(false);
    if (!wx.ok || !wx.timezone) {
      addMessage(logId, "zeno", wx.error || `couldn't find the timezone for ${city}`);
      return;
    }
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: wx.timezone });
    addMessage(logId, "zeno", `${wx.place}: ${now}`);
    if ($("core-voice").checked) window.ZenoVoice.speak(`in ${wx.place} it's ${now}`);
  }

  async function checkForUpdates() {
    try {
      const info = await window.zeno.checkUpdate();
      if (!info.update) return;
      $("update-text").textContent = `ZENO ${info.latest} is out, you're on ${info.current}`;
      $("update-banner").classList.remove("off");
      $("update-get").onclick = () => window.zeno.openExternal(info.url);
      $("update-dismiss").onclick = () => $("update-banner").classList.add("off");
    } catch {}
  }

  async function loadBalance() {
    try {
      const version = await window.zeno.appVersion();
      const versionEl = $("credits-version");
      if (versionEl) versionEl.textContent = `v${version}`;
    } catch {}
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
      window.ZenoVoice.cancelListening();
      closeSidebar();
    }
  });

  boot();
})();
