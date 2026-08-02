(() => {
  let listening = false;

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

  function pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    return voices.find((v) => /en/i.test(v.lang) && /zira|aria|jenny|eva|susan|hazel|libby|sonia|ana|michelle|female/i.test(v.name)) ||
      voices.find((v) => /en[-_](US|GB)/i.test(v.lang)) ||
      voices.find((v) => /en/i.test(v.lang)) || null;
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, " code block omitted. ")
      .replace(/[*_#`>|]/g, "")
      .slice(0, 1200);
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.04;
    utterance.pitch = 1.25;
    const pick = pickVoice();
    if (pick) utterance.voice = pick;
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  window.ZenoVoice = { startListening, stopListening, speak, stopSpeaking, get listening() { return listening; } };
})();
