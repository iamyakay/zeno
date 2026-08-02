(() => {
  const $ = (id) => document.getElementById(id);
  const island = $("island");
  const stateEl = $("island-state");
  const lineEl = $("island-line");
  const replyEl = $("island-reply");
  const input = $("island-input");
  let config = null;
  let busy = false;
  let listening = false;
  const history = [];

  function speak(text) {
    return window.ZenoVoice.speak(text);
  }

  function setState(mode, line) {
    island.classList.toggle("listening", mode === "listening");
    island.classList.toggle("thinking", mode === "thinking");
    stateEl.textContent = mode === "listening" ? "LISTENING" : mode === "thinking" ? "WORKING" : "ZENO";
    if (line != null) lineEl.textContent = line;
    syncHeight();
  }

  function showReply(text) {
    replyEl.classList.add("on");
    replyEl.textContent = text;
    replyEl.scrollTop = replyEl.scrollHeight;
    syncHeight();
  }

  function addStep(payload) {
    replyEl.classList.add("on");
    const key = `ov-step-${payload.step}`;
    let row = document.getElementById(key);
    if (!row) {
      row = document.createElement("div");
      row.id = key;
      row.className = "step";
      replyEl.appendChild(row);
    }
    row.textContent = payload.note;
    row.className = `step ${payload.state === "done" ? "done" : payload.state === "failed" ? "failed" : ""}`;
    replyEl.scrollTop = replyEl.scrollHeight;
    syncHeight();
  }

  function clearReply() {
    replyEl.classList.remove("on");
    replyEl.textContent = "";
    syncHeight();
  }

  function syncHeight() {
    requestAnimationFrame(() => {
      window.zeno.overlayResize(island.offsetHeight + 18);
    });
  }

  function hide() {
    window.ZenoVoice.stopSpeaking();
    if (listening) {
      window.zeno.cancelListen();
      listening = false;
    }
    island.classList.add("leaving");
    setTimeout(() => {
      island.classList.remove("leaving");
      window.zeno.overlayHide();
    }, 190);
  }

  const AGENT_HINT = /\b(make|create|build|write|code|generate|set ?up|scaffold)\b.*\b(file|files|folder|project|script|website|page|app|html|python|server|game)\b|\brun\b.*\b(command|script|server|test)\b|\binstall\b/i;

  async function handle(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed || busy) return;
    busy = true;
    clearReply();
    setState("thinking", trimmed);
    try {
      const action = window.ZenoCommands.parseAction(trimmed);
      if (action) {
        const result = await window.zeno.runAction(action);
        const line = result.ok ? (result.detail || "done") : `couldn't do that: ${result.error}`;
        setState("idle", line);
        speak(result.ok ? `done. ${action.type === "search" ? "searching" : ""}` : "sorry, that didn't work");
        return;
      }
      if (AGENT_HINT.test(trimmed)) {
        setState("thinking", "on it, working on your task...");
        const result = await window.zeno.agentRun(trimmed);
        if (result.ok) {
          setState("idle", "task complete");
          showReplyWithSteps(result.answer);
          speak("all done");
        } else {
          setState("idle", "task failed");
          showReplyWithSteps(result.error);
          speak("I hit a problem with that task");
        }
        return;
      }
      if (!config) config = await window.zeno.getConfig();
      if (config.apiKey && trimmed.length <= 90 && !/\?\s*$/.test(trimmed)) {
        const routed = await window.ZenoEngine.interpret(config, trimmed);
        if (routed) {
          if (routed.kind === "action") {
            const result = await window.zeno.runAction(routed.action);
            const line = result.ok ? (result.detail || "done") : `couldn't do that: ${result.error}`;
            setState("idle", line);
            speak(result.ok ? `done, ${line}` : "sorry, that didn't work");
            return;
          }
          if (routed.kind === "agent") {
            setState("thinking", "on it, working on your task...");
            const result = await window.zeno.agentRun(routed.task);
            if (result.ok) {
              setState("idle", "task complete");
              showReplyWithSteps(result.answer);
              speak("all done");
            } else {
              setState("idle", "task failed");
              showReplyWithSteps(result.error);
              speak("I hit a problem with that task");
            }
            return;
          }
        }
      }
      if (!config.apiKey) {
        setState("idle", "I need an API key first, open ZENO and set one in CONFIG");
        speak("I need an API key first. open the main window and set one in config.");
        return;
      }
      const messages = [
        { role: "system", content: `You are ZENO, ${config.userName || "the user"}'s voice assistant on their Windows PC. You are warm, upbeat and a little playful. Keep replies short and conversational, two or three sentences, this is a quick voice popup. No markdown, no emoji.` },
        ...history,
        { role: "user", content: trimmed }
      ];
      const result = await window.zeno.chat({ model: config.primaryModel, messages, maxTokens: 400 });
      if (result.ok) {
        history.push({ role: "user", content: trimmed });
        history.push({ role: "assistant", content: result.text });
        while (history.length > 10) history.shift();
        setState("idle", "here you go");
        showReply(result.text);
        speak(result.text);
      } else {
        setState("idle", `error: ${result.error}`);
      }
    } finally {
      busy = false;
    }
  }

  function showReplyWithSteps(answer) {
    replyEl.classList.add("on");
    const div = document.createElement("div");
    div.textContent = answer;
    div.style.marginTop = replyEl.children.length > 0 ? "8px" : "0";
    replyEl.appendChild(div);
    replyEl.scrollTop = replyEl.scrollHeight;
    syncHeight();
  }

  async function startListening() {
    if (busy) return;
    if (listening) {
      window.zeno.cancelListen();
      listening = false;
      setState("idle", "what can I do for you?");
      return;
    }
    window.ZenoVoice.stopSpeaking();
    listening = true;
    setState("listening", "listening...");
    const result = await window.zeno.listen();
    listening = false;
    if (result.ok) {
      input.value = "";
      handle(result.text);
    } else {
      setState("idle", result.error);
    }
  }

  window.zeno.onListenPartial((text) => {
    if (listening) lineEl.textContent = text;
  });

  window.zeno.onAgentStep((payload) => {
    addStep(payload);
  });

  window.zeno.onOverlayActivate(async () => {
    if (!config) config = await window.zeno.getConfig();
    clearReply();
    input.value = "";
    input.focus();
    const greetings = ["what can I do for you?", "yes? I'm listening", "hey, need something?", "at your service"];
    const line = greetings[Math.floor(Math.random() * greetings.length)];
    setState("idle", line);
    await speak(line);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!busy && !listening) startListening();
  });

  window.zeno.onOverlaySoftHide(() => {
    if (!busy && !listening) hide();
  });

  $("island-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = "";
    if (listening) {
      window.zeno.cancelListen();
      listening = false;
    }
    handle(value);
  });

  $("island-mic").addEventListener("click", startListening);
  $("island-close").addEventListener("click", hide);
  $("island-expand").addEventListener("click", () => window.zeno.overlayOpenMain());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });

  syncHeight();
})();
