(() => {
  const history = [];
  const MAX_TURNS = 24;

  function systemPrompt(config) {
    const lines = [
      `You are ZENO, ${config.userName || "the user"}'s personal AI command center running as a desktop app.`,
      "Personality: sharp, calm, a little dry. Like a competent operator, not a cheerleader.",
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

  async function askSingle(config, userText, imageDataUrl) {
    const model = imageDataUrl ? config.visionModel : config.primaryModel;
    const messages = buildMessages(config, userText, imageDataUrl);
    const result = await window.zeno.chat({ model, messages });
    if (result.ok) {
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
    onAgentUpdate?.(squad.map((m) => ({ model: m, state: "working" })));

    const answers = await Promise.all(
      squad.map(async (model) => {
        const result = await window.zeno.chat({ model, messages });
        onAgentUpdate?.([{ model, state: result.ok ? "done" : "failed" }]);
        return { model, ...result };
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

    onAgentUpdate?.([{ model: config.judgeModel, state: "working", judge: true }]);
    const verdict = await window.zeno.chat({
      model: config.judgeModel,
      messages: [
        { role: "system", content: systemPrompt(config) },
        { role: "user", content: judgePrompt }
      ]
    });
    onAgentUpdate?.([{ model: config.judgeModel, state: verdict.ok ? "done" : "failed", judge: true }]);

    const finalText = verdict.ok ? verdict.text : good[0].text;
    pushHistory("user", userText || "[image]");
    pushHistory("assistant", finalText);

    return {
      ok: true,
      text: finalText,
      model: "consensus",
      consensus: {
        total: squad.length,
        agreed: good.length,
        sources: good.map((g) => g.model),
        judge: config.judgeModel
      }
    };
  }

  function clearHistory() {
    history.length = 0;
  }

  window.ZenoEngine = { askSingle, askConsensus, clearHistory };
})();
