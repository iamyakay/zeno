const config = require("./config");

function apiHeaders(cfg) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    "HTTP-Referer": "https://teamzap.uk",
    "X-Title": "ZENO"
  };
}

function cleanReply(choice) {
  let text = choice?.content ?? "";
  if (typeof text !== "string") {
    text = Array.isArray(text) ? text.map((part) => part?.text || "").join("") : String(text ?? "");
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!text && choice?.reasoning) {
    text = String(choice.reasoning).trim();
  }
  return text;
}

async function chat(payload) {
  const cfg = config.load();
  const { model, messages, maxTokens } = payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: apiHeaders(cfg),
      body: JSON.stringify({ model, messages, max_tokens: maxTokens || 2048 }),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, error: data?.error?.message || `HTTP ${response.status}`, model };
    }
    const text = cleanReply(data?.choices?.[0]?.message);
    if (!text) {
      return { ok: false, error: "model returned an empty reply, try another model", model };
    }
    return { ok: true, text, model, usage: data?.usage || null };
  } catch (error) {
    const message = error?.name === "AbortError" ? "request timed out" : String(error?.message || error);
    return { ok: false, error: message, model };
  } finally {
    clearTimeout(timer);
  }
}

async function chatStream(payload, onDelta) {
  const cfg = config.load();
  const { model, messages, maxTokens } = payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: apiHeaders(cfg),
      body: JSON.stringify({ model, messages, max_tokens: maxTokens || 2048, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const data = await response.json();
        message = data?.error?.message || message;
      } catch {}
      return { ok: false, error: message, model };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage) usage = parsed.usage;
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            full += delta;
            onDelta(delta);
          }
        } catch {}
      }
    }
    const text = full.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!text) {
      return { ok: false, error: "model returned an empty reply, try another model", model };
    }
    return { ok: true, text, model, usage };
  } catch (error) {
    const message = error?.name === "AbortError" ? "request timed out" : String(error?.message || error);
    return { ok: false, error: message, model };
  } finally {
    clearTimeout(timer);
  }
}

async function listModels() {
  const cfg = config.load();
  try {
    const response = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const models = (data?.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      free: /:free$/.test(m.id) || (Number(m?.pricing?.prompt) === 0 && Number(m?.pricing?.completion) === 0),
      vision: Boolean(m?.architecture?.input_modalities?.includes?.("image"))
    }));
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function getCredits() {
  const cfg = config.load();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${cfg.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) return { ok: false };
    return { ok: true, credits: data?.data || null };
  } catch {
    return { ok: false };
  }
}

async function generateImage(prompt) {
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `image service returned HTTP ${response.status}` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) {
      return { ok: false, error: "image service returned an empty image" };
    }
    const type = response.headers.get("content-type") || "image/jpeg";
    return { ok: true, dataUrl: `data:${type};base64,${buffer.toString("base64")}` };
  } catch (error) {
    const message = error?.name === "AbortError" ? "image generation timed out" : String(error?.message || error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

const WEATHER_CODES = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "icy fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail"
};

async function getWeather(city) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`, { signal: controller.signal });
    const geo = await geoRes.json();
    const place = geo?.results?.[0];
    if (!place) return { ok: false, error: `couldn't find a place called ${city}` };
    const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`, { signal: controller.signal });
    const wx = await wxRes.json();
    const current = wx?.current;
    if (!current) return { ok: false, error: "weather service gave no data" };
    return {
      ok: true,
      place: `${place.name}${place.country ? ", " + place.country : ""}`,
      timezone: wx.timezone,
      temp: current.temperature_2m,
      feels: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      wind: current.wind_speed_10m,
      sky: WEATHER_CODES[current.weather_code] || "unknown conditions"
    };
  } catch (error) {
    const message = error?.name === "AbortError" ? "weather lookup timed out" : String(error?.message || error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function register(ipcMain) {
  ipcMain.handle("ai:chat", (_event, payload) => chat(payload));
  ipcMain.handle("ai:chat-stream", (event, payload) => {
    return chatStream(payload, (delta) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("ai:delta", { id: payload.id, text: delta });
      }
    });
  });
  ipcMain.handle("ai:models", () => listModels());
  ipcMain.handle("ai:credits", () => getCredits());
  ipcMain.handle("ai:image", (_event, prompt) => generateImage(prompt));
  ipcMain.handle("net:weather", (_event, city) => getWeather(city));
}

module.exports = { register };
