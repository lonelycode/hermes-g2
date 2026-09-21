# Hermes G2

Talk to a self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent) from Even Realities G2 glasses. The app is an Even Hub plugin (a web app running in the Even phone app's WebView) that uses the Hermes **Runs API** for live, interstitial-step streaming, approvals and steering, and the R1 ring / temple touchpads for control.

```
G2 mic ──PCM──▶ STT (proxy or provider) ──text──▶ Hermes /v1/runs ──SSE events──▶ glasses feed
                                                        │  tool.started / tool.completed / message.delta
                                                        │  approval.request  ◀── ring: choose + tap
                                                        └  steer / stop     ◀── voice / contextual menu
```

## What it does

| Screen | Tap | Swipe up / down | Double-tap | Tap-then-hold (contextual menu) |
|---|---|---|---|---|
| **Sessions** (list) | open session / `+ New session` | move selection (firmware) | **exit app** (system confirm dialog) | New session · Reconnect |
| **Chat**, idle | start listening | scroll transcript one page | back to sessions | Stop run · New session · Sessions · Reconnect |
| **Chat**, listening | stop & send (ignored if no audio) | – | cancel listening | |
| **Chat**, run in progress | listen → send as **steer** | scroll (auto-follow resumes when you scroll past the end) | back to sessions (run keeps going) | Stop run |
| **Approval** | confirm highlighted choice | move between choices | Deny | |

The chat feed shows every interstitial step, not just the answer:

```
▶ You: what changed in the repo today
   · Let me look into that.
   ● terminal 0.9s: ls -la ~/projects | head
   × web_search 0.5s: even realities g2 sdk
   → HTTP 429 rate limited by provider
   » subagent: Summarise the directory listing
■ Hermes: The directory has 12 entries. The only
document is notes.md …
```

Turns are labelled (`▶ You:` / `■ Hermes:`) and flush-left; everything that happens in between (tool steps `○/●/×` running / done / failed, `·` commentary or system notes, `»` subagents, `?` approvals) is indented under the turn. The status bar animates (`●○○ → ○●○ → ○○●`) whenever something is in flight and names the state: connecting, thinking, the running tool, working (polling), waiting for approval, transcribing, sending. Only glyphs present in the G2 firmware font are used (see `scripts/check-glyphs.mjs`).

Tool events carry raw JSON previews; the feed reduces each call to the tool name plus its one meaningful argument (command, query, path, url …) and hides results unless the call failed. The **Transcript detail** setting switches to `verbose` (argument and result previews, reasoning summaries) when you want more.

Approvals use every choice the gateway offers (`once`, `session`, `always`, `deny`; fewer when the gateway flags a command as risky). If the live stream drops, the app falls back to polling `GET /v1/runs/{id}` and still surfaces pending approvals from the run status.

## Layout

```
src/main.ts              bridge bootstrap, event fan-out
src/app/controller.ts    state machine: sessions ⇄ chat ⇄ approval, runs, mic
src/app/feed.ts          transcript model, wrapping + paging
src/hermes/client.ts     Hermes API client (sessions, runs, SSE via fetch, approval, steer, stop)
src/glasses/display.ts   page layouts + coalesced text upgrades
src/glasses/input.ts     ring/temple event → gesture
src/stt/                 PCM → WAV, transcription entry point
src/ui/companion.ts      phone-side settings / test / mirror / log
shared/stt-providers.mjs ElevenLabs Scribe · OpenAI-compatible · Deepgram adapters (used by app + proxy)
shared/stt-live.mjs      Deepgram live (streaming) client, used by the app (direct) and the proxy relay
src/stt/live.ts          live session: proxy relay or direct Deepgram, with batch fallback
proxy/server.mjs         CORS-clean reverse proxy for Hermes + STT relay (batch + live WebSocket)
proxy/ws-min.mjs         dependency-free RFC 6455 server framing for the live relay
scripts/mock-hermes.mjs  fake gateway for the simulator
scripts/hermes-cors-patch.py  optional: patch the real gateway instead of proxying
```

## 1. Gateway: proxy (recommended) or patch

The stock Hermes gateway does **not** put CORS headers on the `GET /v1/runs/{id}/events` stream (its CORS middleware runs after the streaming response has already sent its headers), and it returns `403` to any request carrying an `Origin` header unless `API_SERVER_CORS_ORIGINS` is set. Both break a WebView client. The community `hermes-cors-patch.py` no longer matches upstream because the run handlers moved to `gateway/platforms/api_server_runs.py`, so it silently does nothing.

**Option A — run the proxy on the gateway host (or anywhere on your tailnet):**

```bash
cp .env.example .env         # set HERMES_URL, HERMES_API_KEY, STT_PROVIDER, STT_API_KEY
npm run proxy                # http://0.0.0.0:8643
curl http://<host>:8643/proxy/health
```

The proxy forwards everything else to Hermes untouched (streaming both ways, `Origin` stripped so the gateway's own CORS list is irrelevant), adds CORS to every response including SSE, authenticates the phone with `PROXY_AUTH_KEY` (defaults to `HERMES_API_KEY`) before injecting the real gateway key upstream, and serves `POST /stt/transcribe` plus the `ws://…/stt/stream` live relay so the STT key never lands on the phone. Point the app at `http://<host>:8643`. Set `STT_LIVE_DEBUG=1` to log the raw Deepgram messages.

**Option B — patch the gateway** (re-apply after `hermes update`):

```bash
python3 scripts/hermes-cors-patch.py ~/.hermes/hermes-agent   # idempotent, keeps .bak-cors
# in the gateway env: API_SERVER_CORS_ORIGINS=*  (or the WebView origin)
systemctl restart hermes-gateway
```

Then point the app straight at `http://<tailnet-ip>:8642` and pick a direct STT mode.

**Unpatched gateway, no proxy:** the app still works in a degraded mode. When the event stream is blocked it falls back to polling `GET /v1/runs/{id}` every 2 s, so you get the final answer, failures and approval prompts, but not the live tool-by-tool steps (the status bar shows the gateway's `last_event` instead). You must still set `API_SERVER_CORS_ORIGINS=*`, otherwise every request from the WebView gets a 403.

Keep the gateway on a private network (Tailscale). Never expose it or the proxy to the public internet: the proxy passes through whatever bearer token the client sends.

## 2. Speech-to-text

The glasses deliver raw 16 kHz PCM; Hermes has no audio endpoint, so a transcription provider is required. Supported: **ElevenLabs Scribe** (`scribe_v1`), any **OpenAI-compatible** `/v1/audio/transcriptions` (OpenAI, Groq, whisper.cpp / faster-whisper servers), **Deepgram** (`nova-3`). Choose `proxy` mode in the app to keep the key on the server, or a direct mode with the key entered on the phone.

**Live preview.** With `proxy` mode (when the proxy's `STT_PROVIDER=deepgram`) or `deepgram` mode, the transcript streams onto the glasses while you talk: the pending turn appears at the bottom of the feed as `▶ what changed in the …` and updates every few hundred milliseconds, so you can see a mis-hearing before you send. The second tap flushes the stream and sends the final text (typically within 200 ms). The proxy relays this over a WebSocket at `ws://<proxy>/stt/stream` (authenticated with the same key), so whitelist the proxy's `ws://` origin as well as `http://` in `app.json` when packaging. ElevenLabs and OpenAI modes have no live path; they transcribe the whole clip after the second tap, and the app also falls back to that if the live socket fails.

Clips shorter than 0.3 s or quieter than the RMS threshold (default 200, tune it in settings using the audio stats shown in the companion UI) are discarded.

## 3. Run it

```bash
npm install
cp .env.example .env.development.local   # optional dev-only defaults (VITE_HERMES_URL, VITE_HERMES_KEY, …); never baked into builds
npm run dev                    # Vite on :5173
```

**Simulator** (no hardware): `npm run mock` (fake Hermes on :8642, key `mock`) then `npm run simulate`. Say "approve" to trigger an approval, "slow" for a long run to steer or stop, "fail" for a failure. The simulator has no microphone; use `--aid` to pick an audio device, or drive it headlessly:

```bash
npx evenhub-simulator http://localhost:5173 --automation-port 9898
curl -X POST localhost:9898/api/input -H 'content-type: application/json' -d '{"action":"click"}'
```

**Real glasses**: enable Developer Mode in the Even app, then

```bash
VITE_HMR_HOST=<your-lan-or-tailnet-ip> npm run dev
npx evenhub qr --url "http://<your-lan-or-tailnet-ip>:5173"
```

Scan the QR from the Even Hub tab. The companion page on the phone is where you enter the gateway URL and key, run **Test Hermes**, watch a live mirror of the glasses, and can type a message instead of talking.

Simulator quirks worth knowing: its `/api/console` only flushes when bridge traffic happens and idle timers are throttled, so judge behaviour by `/api/screenshot/glasses`, not console timing. In dev builds `?say=hello%7Csecond&gap=8000` on the app URL types messages on a timer for scripted runs.

**Package**: update the `network.whitelist` in `app.json` with the exact origins you use (gateway or proxy, and any direct STT host; wildcards are not supported), then

```bash
npm run pack        # → hermes-g2.ehpk (builds first; uses --sdk-ver 0.0.15)
```

and sideload through the dev portal (Private Testing) or submit.

## Hermes API surface used

`GET /health` · `GET /v1/capabilities` · `GET/POST /api/sessions` · `GET /api/sessions/{id}/messages` · `POST /v1/runs` · `GET /v1/runs/{id}` · `GET /v1/runs/{id}/events` (SSE: `message.delta`, `message.interim`, `tool.started`, `tool.completed`, `reasoning.available`, `subagent.start/complete`, `approval.request`, `approval.responded`, `run.steered`, `run.completed/failed/cancelled/interrupted`) · `POST /v1/runs/{id}/approval` · `POST /v1/runs/{id}/steer` · `POST /v1/runs/{id}/stop`.

Clarifying questions from the agent (the `clarify` tool) have no API-server transport in Hermes today; they arrive as the run's final text and you answer by talking.

## Tests

```bash
npm test          # text wrapping, feed paging, SSE parser, WAV helpers (node:test)
npm run typecheck
```

## License

[GNU AGPL v3](LICENSE.md).
