(() => {
  let listening = false;
  let currentAudio = null;
  let currentSocket = null;
  let neuralBroken = false;

  const NEURAL_VOICE = "en-US-AriaNeural";

  async function startListening(onResult, onEnd) {
    if (listening) {
      stopListening();
      return true;
    }
    listening = true;
    try {
      const result = await window.zeno.listen();
      listening = false;
      if (result.ok) {
        onResult(result.text, true);
      } else {
        onEnd(result.error);
      }
    } catch (error) {
      listening = false;
      onEnd(String(error?.message || error));
    }
    return true;
  }

  function stopListening() {
    if (listening) {
      window.zeno.cancelListen();
      listening = false;
    }
  }

  function cleanForSpeech(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, " code block omitted. ")
      .replace(/https?:\/\/\S+/g, " a link ")
      .replace(/[*_#`>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);
  }

  function escapeXml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function requestId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function speakNeural(text) {
    return new Promise(async (resolve, reject) => {
      let settled = false;
      const fail = (why) => { if (!settled) { settled = true; reject(new Error(why)); } };
      const done = () => { if (!settled) { settled = true; resolve(); } };
      let auth;
      try {
        auth = await window.zeno.ttsToken();
      } catch {
        fail("no token");
        return;
      }
      const id = requestId();
      const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${auth.token}&Sec-MS-GEC=${auth.gec}&Sec-MS-GEC-Version=${auth.version}&ConnectionId=${id}`;
      let socket;
      try {
        socket = new WebSocket(url);
      } catch {
        fail("socket failed");
        return;
      }
      currentSocket = socket;
      socket.binaryType = "arraybuffer";
      const chunks = [];
      const guard = setTimeout(() => { try { socket.close(); } catch {} fail("tts timed out"); }, 15000);
      socket.onopen = () => {
        const stamp = new Date().toISOString();
        socket.send(`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${NEURAL_VOICE}'><prosody pitch='+0Hz' rate='+8%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
        socket.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}\r\nPath:ssml\r\n\r\n${ssml}`);
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          if (event.data.includes("Path:turn.end")) {
            clearTimeout(guard);
            try { socket.close(); } catch {}
            if (chunks.length === 0) {
              fail("no audio");
              return;
            }
            const blob = new Blob(chunks, { type: "audio/mpeg" });
            const audio = new Audio(URL.createObjectURL(blob));
            currentAudio = audio;
            audio.onended = () => { currentAudio = null; done(); };
            audio.onerror = () => { currentAudio = null; fail("playback failed"); };
            audio.play().catch(() => fail("playback blocked"));
          }
          return;
        }
        const data = new Uint8Array(event.data);
        const headerEnd = findHeaderEnd(data);
        if (headerEnd > 0 && headerContains(data, headerEnd, "Path:audio")) {
          chunks.push(data.slice(headerEnd));
        }
      };
      socket.onerror = () => { clearTimeout(guard); fail("socket error"); };
      socket.onclose = () => { clearTimeout(guard); setTimeout(() => fail("closed early"), 300); };
    });
  }

  function findHeaderEnd(data) {
    for (let i = 0; i < Math.min(data.length - 3, 400); i += 1) {
      if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) return i + 4;
    }
    return -1;
  }

  function headerContains(data, headerEnd, needle) {
    let header = "";
    for (let i = 2; i < headerEnd; i += 1) header += String.fromCharCode(data[i]);
    return header.includes(needle);
  }

  function speakLocal(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) {
        resolve();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.04;
      utterance.pitch = 1.25;
      const voices = window.speechSynthesis.getVoices();
      const pick = voices.find((v) => /en/i.test(v.lang) && /zira|aria|jenny|eva|susan|hazel|libby|sonia|ana|michelle|female/i.test(v.name)) ||
        voices.find((v) => /en[-_](US|GB)/i.test(v.lang)) ||
        voices.find((v) => /en/i.test(v.lang)) || null;
      if (pick) utterance.voice = pick;
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      setTimeout(finish, Math.max(4000, text.length * 90));
      window.speechSynthesis.speak(utterance);
    });
  }

  async function speak(text) {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    stopSpeaking();
    if (!neuralBroken && navigator.onLine) {
      try {
        await speakNeural(clean);
        return;
      } catch {
        neuralBroken = true;
        setTimeout(() => { neuralBroken = false; }, 120000);
      }
    }
    await speakLocal(clean);
  }

  function stopSpeaking() {
    if (currentSocket) {
      try { currentSocket.close(); } catch {}
      currentSocket = null;
    }
    if (currentAudio) {
      try { currentAudio.pause(); } catch {}
      currentAudio = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  window.ZenoVoice = { startListening, stopListening, speak, stopSpeaking, get listening() { return listening; } };
})();
