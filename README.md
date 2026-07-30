# ZENO

A personal AI command center for Windows. One desktop app with a holographic globe you talk to, powered by whatever AI models you want.

Built with Electron, plain JS and zero framework bloat.

## What it does

- **Chat with any model.** Works with OpenRouter out of the box (free models included), and any OpenAI compatible API: Groq, Together, local Ollama or LM Studio. Just swap the base URL and key in CONFIG.
- **Multi-AI consensus.** Flip one toggle and your question goes to several models in parallel. A judge model merges what they agree on and flags what they don't. Watch each agent work in real time.
- **Voice.** Click the globe, speak, done. Speech recognition runs fully offline through Windows' built in engine, no cloud, no cost. Replies are spoken back if you want.
- **Image generation.** Say "generate an image of a neon samurai" and the picture appears in chat. Free, no key needed.
- **Vision.** Attach any image and ask questions about it.
- **App commands.** "open youtube", "open notepad", "open ggbalcony.com", "search best mechanical keyboards". ZENO opens sites, launches apps and runs searches for you.
- **Two themes.** Green matrix or red alert. Everything glows accordingly.

## Setup

Needs [Node.js](https://nodejs.org) 18 or newer and Windows.

```
git clone https://github.com/iamyakay/zeno.git
cd zeno
npm install
npm start
```

First launch: open CONFIG, paste your OpenRouter API key (free at [openrouter.ai/keys](https://openrouter.ai/keys)) and hit save. That's it.

Double click `ZENO.bat` to launch it like a normal app, or run `make-shortcut.ps1` once to get a desktop shortcut.

## Commands it understands

```
open browser / youtube / github / spotify / gmail / netflix ...
open notepad / calculator / paint / explorer / terminal
open anysite.com
search <anything>
generate an image of <anything>
imagine <anything>
```

Everything also works by voice. Click the globe, say it, it happens.

## Config

All settings live in the CONFIG view inside the app: API key, base URL, primary model, vision model, judge model, the consensus squad, theme, voice and your name. Stored locally in your user folder, nothing leaves your machine except the API calls you make.

## Credits

Made by Zap

- GitHub: [iamyakay](https://github.com/iamyakay)
- Discord: Sethlowk

## License

MIT
