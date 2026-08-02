(() => {
  const APP_NAMES = new Set(["notepad", "calculator", "calc", "paint", "explorer", "files", "cmd", "terminal"]);
  const SITE_NAMES = new Set(["browser", "google", "youtube", "github", "discord", "spotify", "reddit", "twitter", "x", "twitch", "gmail", "maps", "netflix", "openrouter"]);
  const FOLDER_NAMES = ["downloads", "documents", "pictures", "music", "videos", "desktop", "home"];

  function parseSystem(t) {
    if (/^(?:turn\s+)?volume\s+up$|^louder$/.test(t)) return { type: "system", name: "volume-up" };
    if (/^(?:turn\s+)?volume\s+down$|^quieter$/.test(t)) return { type: "system", name: "volume-down" };
    if (/^(?:un)?mute(?:\s+(?:the\s+)?(?:pc|sound|audio|volume))?$/.test(t)) return { type: "system", name: "mute" };
    if (/^lock(?:\s+(?:the\s+)?(?:pc|computer|screen))?$/.test(t)) return { type: "system", name: "lock" };
    if (/^(?:take\s+a\s+)?screenshot$/.test(t)) return { type: "system", name: "screenshot" };
    if (/^(?:empty|clear)\s+(?:the\s+)?(?:recycle\s+)?bin$/.test(t)) return { type: "system", name: "recycle" };
    const shut = t.match(/^shut\s*down(?:\s+(?:the\s+)?(?:pc|computer))?(?:\s+in\s+(\d+)\s*min(?:ute)?s?)?$/);
    if (shut) return { type: "system", name: "shutdown", minutes: shut[1] ? Number(shut[1]) : 1 };
    if (/^(?:cancel|abort|stop)\s+(?:the\s+)?shut\s*down$/.test(t)) return { type: "system", name: "cancel-shutdown" };
    return null;
  }

  function parseAction(text) {
    const t = text.trim().toLowerCase().replace(/^zeno[,.!\s]+/, "").replace(/[.!?]+$/, "");
    const system = parseSystem(t);
    if (system) return system;
    let m = t.match(/^(?:open|launch|start|go to)\s+(?:the\s+|my\s+|a\s+)?(.+)$/);
    if (m) {
      const target = m[1].trim();
      if (/^https?:\/\//.test(target)) return { type: "url", url: target };
      if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(target)) return { type: "url", url: `https://${target}` };
      const word = target.replace(/\s+app$/, "");
      if (APP_NAMES.has(word)) return { type: "app", name: word };
      if (SITE_NAMES.has(word)) return { type: "site", name: word };
      const folder = word.replace(/\s+folder$/, "");
      if (FOLDER_NAMES.includes(folder)) return { type: "folder", name: folder };
      return { type: "anyapp", name: word };
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

  window.ZenoCommands = { parseAction, parseImagePrompt, extractJsonAction };
})();
