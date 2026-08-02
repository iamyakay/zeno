(() => {
  let listening = false;
  let currentAudio = null;
  let currentSocket = null;
  let neuralBroken = false;
  let capture = null;
  let whisperOk = null;
  let settingUp = false;

  const NEURAL_VOICE = "en-US-AriaNeural";

  async function ensureWhisper(onPartial) {
    if (whisperOk === true) return true;
    if (await window.zeno.whisperReady()) {
      whisperOk = true;
      return true;
    }
    if (settingUp) return false;
    settingUp = true;
    try {
      onPartial?.("first time setup, downloading AI speech engine...");
      const result = await window.zeno.whisperSetup();
      whisperOk = result.ok === true;
      return whisperOk;
    } finally {
      settingUp = false;
    }
  }

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
    return buffer;
  }

  function resampleTo16k(chunks, fromRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const joined = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { joined.set(c, off); off += c.length; }
    if (fromRate === 16000) return joined;
    const ratio = fromRate / 16000;
    const out = new Float32Array(Math.floor(joined.length / ratio));
    for (let i = 0; i < out.length; i += 1) {
      const pos = i * ratio;
      const left = Math.floor(pos);
      const frac = pos - left;
      out[i] = joined[left] * (1 - frac) + (joined[Math.min(left + 1, joined.length - 1)] * frac);
    }
    return out;
  }

  async function whisperListen(onResult, onEnd, onLevel) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });
    } catch {
      return null;
    }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let spokeYet = false;
    let silentFrames = 0;
    let voicedFrames = 0;
    let stopped = false;

    const finishCapture = () => {
      if (stopped) return;
      stopped = true;
      try { processor.disconnect(); source.disconnect(); } catch {}
      for (const track of stream.getTracks()) track.stop();
      context.close().catch(() => {});
    };

    const settle = async (cancelled) => {
      finishCapture();
      clearTimeout(hardStop);
      listening = false;
      capture = null;
      if (cancelled) {
        onEnd(null);
        return;
      }
      if (!spokeYet) {
        onEnd("didn't hear anything. check your mic volume in Windows sound settings");
        return;
      }
      onResult("", false, "transcribing...");
      const samples = resampleTo16k(chunks, context.sampleRate);
      const pad = new Float32Array(4800);
      const padded = new Float32Array(samples.length + pad.length * 2);
      padded.set(pad, 0);
      padded.set(samples, pad.length);
      padded.set(pad, pad.length + samples.length);
      const wav = encodeWav(padded, 16000);
      const result = await window.zeno.whisperTranscribe(wav);
      if (result.ok && result.text) {
        const normalized = result.text.replace(/\b(?:zano|zeeno|xeno|zenno|seno)\b/gi, "zeno");
        onResult(normalized, true);
      } else {
        onEnd(result.ok ? "I heard you but couldn't make out any words, try again closer to the mic" : `speech engine error: ${result.error}`);
      }
    };

    processor.onaudioprocess = (event) => {
      if (stopped) return;
      const data = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      onLevel?.(rms);
      const frameMs = (data.length / context.sampleRate) * 1000;
      if (rms > 0.012) {
        voicedFrames += 1;
        if (voicedFrames >= 2) spokeYet = true;
        silentFrames = 0;
      } else {
        voicedFrames = 0;
        silentFrames += 1;
        const silentMs = silentFrames * frameMs;
        if (spokeYet && silentMs > 900) settle(false);
        else if (!spokeYet && silentMs > 7000) settle(false);
      }
    };

    source.connect(processor);
    processor.connect(context.destination);
    const hardStop = setTimeout(() => settle(false), 20000);
    capture = { cancel: () => settle(true), forceStop: () => settle(false) };
    return capture;
  }

  async function startListening(onResult, onEnd, onLevel) {
    if (listening) {
      stopListening();
      return true;
    }
    listening = true;
    const useWhisper = await ensureWhisper((msg) => onResult?.("", false, msg));
    if (useWhisper) {
      const started = await whisperListen(onResult, onEnd, onLevel);
      if (started) return true;
    }
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
    if (capture) {
      capture.forceStop();
      return;
    }
    if (listening) {
      window.zeno.cancelListen();
      listening = false;
    }
  }

  function cancelListening() {
    if (capture) {
      capture.cancel();
      return;
    }
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

  window.ZenoVoice = { startListening, stopListening, cancelListening, speak, stopSpeaking, get listening() { return listening; } };
})();
