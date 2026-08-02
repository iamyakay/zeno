(() => {
  const history = [];
  const MAX_TURNS = 24;

  function systemPrompt(config) {
    const persona = String(config.persona || "").trim();
    const lines = [
      `You are ZENO, ${config.userName || "the user"}'s personal AI command center running as a desktop app.`,
      persona
        ? `Personality: ${persona}. Stay in character.`
        : "Personality: sharp, calm, a little dry. Like a competent operator, not a cheerleader.",
      "Keep answers tight and useful. Use short paragraphs. No emoji unless asked.",
      "If you are unsure, say so plainly instead of guessing.",
      "The app around you can also open websites and apps (user says: open youtube, open notepad), run web searches (search for ...), and generate images (generate an image of ...).",
      "If the user asks what you can do, mention those commands.",
      "Never reply with JSON, tool call syntax or action objects. Always answer in plain natural language, the app handles commands on its own."
    ];
    const memory = Array.isArray(config.memory) ? config.memory : [];
    if (memory.length > 0) {
      lines.push("Things the user asked you to remember: " + memory.map((m) => m.fact).join("; "));
    }
    return lines.join(" ");
  }

  function pushHistory(role, content) {
    history.push({ role, content });
    while (history.length > MAX_TURNS) history.shift();
  }

  function buildMessages(config, userText, imageDataUrl) {
    const messages = [{ role: "system", content: systemPrompt(config) }, ...history];
    if (imageDataUrl) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userText || "describe this image" },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: "user", content: userText });
    }
    return messages;
  }

  let streamCounter = 0;
  const streamHandlers = new Map();

  window.zeno.onAiDelta((payload) => {
    streamHandlers.get(payload.id)?.(payload.text);
  });

  async function askSingle(config, userText, imageDataUrl, onDelta, options) {
    const model = imageDataUrl ? config.visionModel : config.primaryModel;
    const deepThink = Boolean(options?.deepThink);
    const messages = buildMessages(config, userText, imageDataUrl);
    let thinkUsage = null;
    if (deepThink && userText) {
      const thinkMessages = [
        { role: "system", content: "You are a careful reasoner. Think through the user's request step by step: break it down, consider approaches and edge cases, note pitfalls. Output only your reasoning notes, compact but thorough. Do not write the final answer yet." },
        ...history.slice(-6),
        { role: "user", content: userText }
      ];
      const thought = await window.zeno.chat({ model, messages: thinkMessages, maxTokens: 1200 });
      if (thought.ok) {
        thinkUsage = thought.usage;
        messages.splice(messages.length - 1, 0, {
          role: "system",
          content: `Private reasoning notes for this request (the user cannot see these, use them to give a sharper answer):\n${thought.text}`
        });
      }
    }
    let result;
    if (typeof onDelta === "function") {
      streamCounter += 1;
      const id = `s${streamCounter}`;
      streamHandlers.set(id, onDelta);
      try {
        result = await window.zeno.chatStream({ id, model, messages, maxTokens: deepThink ? 4000 : 2048 });
      } finally {
        streamHandlers.delete(id);
      }
    } else {
      result = await window.zeno.chat({ model, messages });
    }
    if (result.ok) {
      if (thinkUsage) {
        result.usage = {
          prompt_tokens: Number(result.usage?.prompt_tokens || 0) + Number(thinkUsage.prompt_tokens || 0),
          completion_tokens: Number(result.usage?.completion_tokens || 0) + Number(thinkUsage.completion_tokens || 0),
          total_tokens: Number(result.usage?.total_tokens || 0) + Number(thinkUsage.total_tokens || 0)
        };
        result.deepThink = true;
      }
      pushHistory("user", userText || "[image]");
      pushHistory("assistant", result.text);
    }
    return result;
  }

  async function askConsensus(config, userText, imageDataUrl, onAgentUpdate) {
    const squad = (config.consensusModels || []).filter(Boolean);
    if (squad.length < 2) {
      return askSingle(config, userText, imageDataUrl);
    }

    const messages = buildMessages(config, userText, imageDataUrl);
    onAgentUpdate?.(squad.map((m) => ({ model: m, state: "working", startedAt: performance.now() })));

    const answers = await Promise.all(
      squad.map(async (model) => {
        const startedAt = performance.now();
        const result = await window.zeno.chat({ model, messages });
        const ms = Math.round(performance.now() - startedAt);
        onAgentUpdate?.([{ model, state: result.ok ? "done" : "failed", ms }]);
        return { model, ms, ...result };
      })
    );

    const good = answers.filter((a) => a.ok && a.text.trim());
    if (good.length === 0) {
      return { ok: false, error: answers[0]?.error || "all consensus models failed", model: "consensus" };
    }
    if (good.length === 1) {
      pushHistory("user", userText || "[image]");
      pushHistory("assistant", good[0].text);
      return { ...good[0], consensus: { total: squad.length, agreed: 1, sources: good.map((g) => g.model) } };
    }

    const judgePrompt = [
      `Question from the user: ${userText || "[image analysis]"}`,
      "",
      "Multiple AI models answered independently. Their answers:",
      ...good.map((a, i) => `\n[MODEL ${i + 1}: ${a.model}]\n${a.text}`),
      "",
      "Your job: produce one final answer.",
      "Merge the points the models agree on, those are likely correct.",
      "If they disagree on something important, give the majority position and add a short 'disputed:' note about the disagreement.",
      "Do not mention that you are merging answers. Just answer well.",
    ].join("\n");

    onAgentUpdate?.([{ model: config.judgeModel, state: "working", judge: true, startedAt: performance.now() }]);
    const judgeStartedAt = performance.now();
    const verdict = await window.zeno.chat({
      model: config.judgeModel,
      messages: [
        { role: "system", content: systemPrompt(config) },
        { role: "user", content: judgePrompt }
      ]
    });
    onAgentUpdate?.([{ model: config.judgeModel, state: verdict.ok ? "done" : "failed", judge: true, ms: Math.round(performance.now() - judgeStartedAt) }]);

    const finalText = verdict.ok ? verdict.text : good[0].text;
    pushHistory("user", userText || "[image]");
    pushHistory("assistant", finalText);

    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (const answer of [...good, verdict]) {
      if (answer?.usage) {
        usage.prompt_tokens += Number(answer.usage.prompt_tokens || 0);
        usage.completion_tokens += Number(answer.usage.completion_tokens || 0);
        usage.total_tokens += Number(answer.usage.total_tokens || 0);
      }
    }

    return {
      ok: true,
      text: finalText,
      model: "consensus",
      usage: usage.total_tokens > 0 ? usage : null,
      consensus: {
        total: squad.length,
        agreed: good.length,
        sources: good.map((g) => g.model),
        judge: config.judgeModel
      }
    };
  }

  const INTENT_PROMPT = [
    "You route commands for ZENO, a Windows PC assistant. Given the user's words, decide if this is a direct action on the computer or a normal chat message.",
    "Reply with EXACTLY ONE JSON object, nothing else.",
    'Action formats:',
    '{"intent":"app","name":"<app name to launch, e.g. valorant, word, obs>"}',
    '{"intent":"url","url":"https://..."}',
    '{"intent":"search","query":"..."}',
    '{"intent":"system","name":"volume-up|volume-down|mute|lock|screenshot|recycle|shutdown|cancel-shutdown|restart|sleep|battery|processes","minutes":10}',
    '{"intent":"system","name":"brightness","level":70}',
    '{"intent":"system","name":"media","key":"play-pause|next|previous|stop"}',
    '{"intent":"system","name":"kill","target":"<process name>"}',
    '{"intent":"system","name":"settings-page","page":"bluetooth|wifi|network|display|sound|battery|apps|updates"}',
    '{"intent":"system","name":"type","text":"<text to type>"}',
    '{"intent":"folder","name":"downloads|documents|pictures|music|videos|desktop|home"}',
    '{"intent":"image","prompt":"<what to draw>"}',
    '{"intent":"agent","task":"<the full task, for multi-step jobs like creating files, coding, installing, running commands>"}',
    '{"intent":"chat"}',
    "Rules: only pick an action if the user is clearly telling the computer to do something. Questions, conversation and anything unclear are chat. Commands like pause the music, skip this song, turn it up, open spotify, close chrome, put the pc to sleep, are actions. minutes/level/key/target/page fields only when relevant."
  ].join("\n");

  async function interpret(config, text) {
    if (!config.apiKey) return null;
    const result = await window.zeno.chat({
      model: config.primaryModel,
      messages: [
        { role: "system", content: INTENT_PROMPT },
        { role: "user", content: String(text).slice(0, 400) }
      ],
      maxTokens: 150
    });
    if (!result.ok) return null;
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
    const intent = String(parsed.intent || "").toLowerCase();
    if (intent === "app" && parsed.name) return { kind: "action", action: { type: "anyapp", name: String(parsed.name) } };
    if (intent === "url" && /^https?:\/\//.test(String(parsed.url || ""))) return { kind: "action", action: { type: "url", url: String(parsed.url) } };
    if (intent === "search" && parsed.query) return { kind: "action", action: { type: "search", query: String(parsed.query) } };
    if (intent === "system" && parsed.name) {
      const action = { type: "system", name: String(parsed.name) };
      if (parsed.minutes != null) action.minutes = Number(parsed.minutes);
      if (parsed.level != null) action.level = Number(parsed.level);
      if (parsed.key) action.key = String(parsed.key);
      if (parsed.target) action.target = String(parsed.target);
      if (parsed.page) action.page = String(parsed.page);
      if (parsed.text) action.text = String(parsed.text);
      return { kind: "action", action };
    }
    if (intent === "folder" && parsed.name) return { kind: "action", action: { type: "folder", name: String(parsed.name) } };
    if (intent === "image" && parsed.prompt) return { kind: "image", prompt: String(parsed.prompt) };
    if (intent === "agent" && parsed.task) return { kind: "agent", task: String(parsed.task) };
    return null;
  }

  function clearHistory() {
    history.length = 0;
  }

  function getHistory() {
    return [...history];
  }

  function setHistory(entries) {
    history.length = 0;
    if (Array.isArray(entries)) {
      for (const entry of entries.slice(-MAX_TURNS)) history.push(entry);
    }
  }

  window.ZenoEngine = { askSingle, askConsensus, interpret, clearHistory, getHistory, setHistory };
})();
