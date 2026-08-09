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
  const cmdHistory = [];
  let cmdHistoryIdx = -1;

  function speak(text) {
    return window.ZenoVoice.speak(text);
  }

  function setState(mode, line) {
    island.classList.toggle("listening", mode === "listening");
    island.classList.toggle("thinking", mode === "thinking");
    stateEl.textContent = mode === "listening" ? "LISTENING" : mode === "thinking" ? "WORKING" : "ZENO";
    if (line != null) lineEl.textContent = line;
    const mic = document.querySelector('.quick[data-act="mic"]');
    if (mic) mic.classList.toggle("live", mode === "listening");
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
      window.ZenoVoice.cancelListening();
      listening = false;
    }
    island.classList.add("leaving");
    setTimeout(() => {
      island.classList.remove("leaving");
      window.zeno.overlayHide();
    }, 190);
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

  function pushCmdHistory(text) {
    if (!text || cmdHistory[0] === text) return;
    cmdHistory.unshift(text);
    if (cmdHistory.length > 40) cmdHistory.pop();
    cmdHistoryIdx = -1;
  }

  const AGENT_HINT = /\b(make|create|build|write|code|generate|set ?up|scaffold)\b.*\b(file|files|folder|project|script|website|page|app|html|python|server|game)\b|\brun\b.*\b(command|script|server|test)\b|\binstall\b/i;

  const COMMAND_HINT = /\b(open|close|launch|start|play|pause|stop|next|previous|mute|volume|lock|shutdown|restart|screenshot|search|find|set|turn|switch|focus|remind|timer|kill|clip|clipboard)\b/i;

  async function handle(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed || busy) return;
    busy = true;
    pushCmdHistory(trimmed);
    clearReply();
    setState("thinking", trimmed);
    try {
      if (!config) config = await window.zeno.getConfig();

      const action = window.ZenoCommands.parseAction(trimmed);
      if (action) {
        const result = await window.zeno.runAction(action);
        const line = result.ok ? (result.detail || "done") : `couldn't do that: ${result.error}`;
        setState("idle", line);
        speak(result.ok ? `done` : "sorry, that didn't work");
        return;
      }

      if (AGENT_HINT.test(trimmed)) {
        setState("thinking", "on it...");
        const result = await window.zeno.agentRun(trimmed);
        if (result.ok) {
          setState("idle", "task complete");
          showReplyWithSteps(result.answer);
          speak("all done");
        } else {
          setState("idle", "task failed");
          showReplyWithSteps(result.error);
          speak("I hit a problem");
        }
        return;
      }

      const looksLikeCommand = COMMAND_HINT.test(trimmed) || trimmed.split(/\s+/).length <= 5;
      if (config.apiKey && looksLikeCommand) {
        const routed = await window.ZenoEngine.interpret(config, trimmed);
        if (routed) {
          if (routed.kind === "action") {
            const result = await window.zeno.runAction(routed.action);
            const line = result.ok ? (result.detail || "done") : `couldn't do that: ${result.error}`;
            setState("idle", line);
            speak(result.ok ? `done` : "sorry, that didn't work");
            return;
          }
          if (routed.kind === "agent") {
            setState("thinking", "on it...");
            const result = await window.zeno.agentRun(routed.task);
            if (result.ok) {
              setState("idle", "task complete");
              showReplyWithSteps(result.answer);
              speak("all done");
            } else {
              setState("idle", "task failed");
              showReplyWithSteps(result.error);
              speak("I hit a problem");
            }
            return;
          }
        }
      }

      if (!config.apiKey) {
        setState("idle", "need an API key. open ZENO and set one in CONFIG");
        speak("I need an API key first");
        return;
      }

      const messages = [
        { role: "system", content: `You are ZENO, ${config.userName || "the user"}'s voice assistant on their Windows PC. Warm, upbeat, a little playful. Keep replies short, two or three sentences max. No markdown, no emoji.` },
        ...history,
        { role: "user", content: trimmed }
      ];

      const streamId = `ov${Date.now()}`;
      let streamed = "";
      replyEl.classList.add("on");
      replyEl.textContent = "";
      setState("idle", "...");

      window.zeno.onAiDelta((payload) => {
        if (payload.id !== streamId) return;
        streamed += payload.text;
        replyEl.textContent = streamed;
        replyEl.scrollTop = replyEl.scrollHeight;
        syncHeight();
      });

      const result = await window.zeno.chatStream({ id: streamId, model: config.primaryModel, messages, maxTokens: 400 });

      if (result.ok) {
        history.push({ role: "user", content: trimmed });
        history.push({ role: "assistant", content: result.text });
        while (history.length > 12) history.shift();
        showReply(result.text);
        await speak(result.text);
        if (config.conversationMode && !busy && !listening) {
          setTimeout(() => { if (!busy && !listening) startListening(); }, 300);
        }
      } else {
        setState("idle", `error: ${result.error}`);
      }
    } finally {
      busy = false;
    }
  }

  async function startListening() {
    if (busy) return;
    if (listening) {
      window.ZenoVoice.cancelListening();
      listening = false;
      setState("idle", "what can I do for you?");
      return;
    }
    window.ZenoVoice.stopSpeaking();
    listening = true;
    setState("listening", "listening...");
    window.ZenoVoice.startListening(
      (text, isFinal, status) => {
        if (isFinal) {
          listening = false;
          input.value = "";
          handle(text);
        } else if (status) {
          lineEl.textContent = status;
        } else if (text) {
          lineEl.textContent = text;
        }
      },
      (error) => {
        listening = false;
        setState("idle", error || "what can I do for you?");
      },
      (level) => {
        const bars = document.querySelectorAll("#island-wave i");
        const boost = Math.min(1, level * 26);
        bars.forEach((bar, i) => {
          bar.style.animation = "none";
          bar.style.transform = `scaleY(${0.3 + boost * (0.5 + Math.sin(Date.now() / 90 + i) * 0.5)})`;
        });
      }
    );
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
    cmdHistoryIdx = -1;
    if (listening) {
      window.ZenoVoice.cancelListening();
      listening = false;
    }
    handle(value);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (cmdHistoryIdx < cmdHistory.length - 1) {
        cmdHistoryIdx += 1;
        input.value = cmdHistory[cmdHistoryIdx];
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (cmdHistoryIdx > 0) {
        cmdHistoryIdx -= 1;
        input.value = cmdHistory[cmdHistoryIdx];
      } else {
        cmdHistoryIdx = -1;
        input.value = "";
      }
    }
  });

  const micBtn = document.querySelector('.quick[data-act="mic"]');

  for (const btn of document.querySelectorAll(".quick[data-cmd]")) {
    btn.addEventListener("click", async () => {
      const result = await window.zeno.runAction({ type: "system", name: btn.dataset.cmd });
      lineEl.textContent = result.ok ? (result.detail || "done") : `couldn't do that: ${result.error}`;
    });
  }

  if (micBtn) micBtn.addEventListener("click", startListening);
  $("island-close").addEventListener("click", hide);
  $("island-expand").addEventListener("click", () => window.zeno.overlayOpenMain());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });

  syncHeight();
})();
