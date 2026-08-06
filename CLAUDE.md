# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ZENO is a Windows-only Electron desktop assistant: a main window with a holographic globe UI, plus a frameless always-on-top "island" overlay summoned with Ctrl+Y. It talks to any OpenAI-compatible chat API (OpenRouter by default), hears through local whisper.cpp, and speaks through Microsoft's Edge neural TTS websocket.

## Commands

```
npm start                                        run the app (electron .)
node --check <file>                              syntax-check a file, there is no linter or test suite
node_modules/.bin/electron-builder.cmd --win     build installer + portable exe into dist/
node build/make-icon.js                          regenerate assets/zeno.png and zeno.ico
```

Release flow: bump `version` in package.json, update the README changelog, commit, push, build, then `gh release create vX.Y.Z dist/ZENO-Setup-X.Y.Z.exe dist/ZENO-portable-X.Y.Z.exe`. Installed apps poll the latest GitHub release (lib/updates.js) and show an update banner, so publishing the GitHub release is what ships an update to users.

## Hard rules from the owner (Ray / Zap / iamyakay)

- No comments in any code, and no em-dash characters anywhere, including README and release notes. CLI flags like `--no-prints` and CSS variables like `--accent` are fine.
- Never add a Claude co-author trailer or any AI attribution to commits.
- Prefer several small commits, one logical change each, over one big commit.
- git IS installed and works in this repo despite what the home-directory CLAUDE.md says.

## Architecture

Two-process Electron app, strict contextIsolation, no nodeIntegration. Every renderer capability crosses IPC through the `window.zeno.*` bridge defined in `preload.js`; adding a feature usually means touching lib module + main.js registration + preload.js + the renderer js.

**Main process**: `main.js` creates both BrowserWindows (main + overlay), the tray, and the Ctrl+Y global shortcut, then wires up modules from `lib/`, each exporting `register(ipcMain, ...)` and owning its `ipcMain.handle` channels:
- `lib/config.js` json config in userData (`zeno-config.json`), defaults plus migration of retired model ids
- `lib/store.js` chats, todos, memory json stores
- `lib/ai.js` chat and streaming chat (SSE parsing, deltas emitted as `ai:delta` events keyed by request id), model list, credits, image generation via Pollinations, weather via Open-Meteo
- `lib/system.js` all Windows control: spawns PowerShell for volume/lock/screenshot/shutdown/etc, wake-word and fallback speech recognition via System.Speech (confidence gate 0.55, never submit partial hypotheses), `launchAnyApp` resolves any installed app through Get-StartApps, system stats for the HUD
- `lib/agent.js` autonomous task loop: model replies with one JSON tool call per turn (run, write_file, append_file, read_file, list_dir, open, final), max 14 steps, destructive command patterns blocked, steps streamed to renderer as `agent:step`
- `lib/whisper.js` local speech-to-text: auto-downloads whisper.cpp binaries and ggml models into userData/whisper on first run, picks tiny.en for clips up to 12s and base.en for longer, tuned for speed (greedy decode, audio-ctx sized to clip length)
- `lib/tts.js` builds the time-based Sec-MS-GEC token and rewrites request headers so the renderer can open the Edge neural TTS websocket; if Microsoft rotates auth again, update TRUSTED_TOKEN and GEC_VERSION here
- `lib/plugins.js` loads user js plugins (name + regex pattern + run) from ./plugins and userData/plugins
- `lib/updates.js` GitHub latest-release version check

**Renderer (main window)**: plain script tags, no bundler, load order matters (`index.html` bottom): globe → voice → markdown → commands → engine → app.
- `js/engine.js` conversation state (24-turn history), system prompt assembly, consensus mode (parallel squad + judge model merge), and `interpret()` which is the AI intent router: classifies any free-form text into app/url/search/system/folder/image/agent/chat JSON and is deliberately biased toward action over chat
- `js/commands.js` fast regex intent parsing tried before the AI router; unknown "open X" falls through to type `anyapp`
- `js/voice.js` shared by both windows: mic capture via getUserMedia (respects `micDevice` from config) with RMS-based voice activity detection (speech ends after ~650ms silence), resample to 16k WAV, whisper transcription, "zeno" mishearing normalization; speak() tries Edge neural TTS (mp3 over websocket, played via Audio) and falls back to local SpeechSynthesis for 2 minutes after a failure
- `js/app.js` glues everything: submit() pipeline order is memory/todo/clipboard regexes → plugins → regex commands → image prompts → AI intent router → chat with streaming; also config UI including mic picker with live level meter, token usage tracking, history, HUD polling
- `js/globe.js` canvas globe + starfield, mood states idle/thinking/listening

**Overlay**: `overlay.html` + `js/overlay.js` + `css/overlay.css`, a black pill at top center. Activation flow: greeting spoken fully first, then mic opens (prevents ZENO hearing itself). Handles the same command routing inline and resizes its own window height via `overlay:resize`.

## Behavioral details worth knowing

- Closing the main window hides to tray; the app only quits from the tray menu (`quitting` flag in main.js). Ctrl+Y works with no window visible.
- The overlay auto-hides on blur unless busy or listening.
- whisper engine files live in `%APPDATA%/zeno/whisper`; deleting that folder forces a re-download.
- CSP in both html files allowlists `wss://speech.platform.bing.com`; new external endpoints need adding there.
- All user speech, config and history stay local; the only network calls are the configured chat API, Pollinations, Open-Meteo, GitHub releases, and the Edge TTS websocket.
