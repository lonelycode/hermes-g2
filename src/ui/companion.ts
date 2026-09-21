// Phone-side companion UI (the WebView the Even app shows). Settings entry, connection tests,
// a live mirror of what the glasses show, and a log — the glasses have no keyboard.

import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../config.ts'
import { HermesClient } from '../hermes/client.ts'
import type { ControllerSnapshot } from '../app/controller.ts'

export interface CompanionCallbacks {
  onSave(settings: Settings): Promise<void>
  onSend?(text: string): Promise<void>
}

export interface Companion {
  setBridgeState(text: string): void
  setSnapshot(snap: ControllerSnapshot): void
  setMirror(layout: string, containers: Record<string, string>): void
  log(line: string): void
}

const FIELDS: Array<{ key: keyof Settings; label: string; type?: string; hint?: string; options?: string[] }> = [
  { key: 'hermesUrl', label: 'Hermes URL (gateway or proxy)', hint: 'e.g. http://100.x.y.z:8642 — or the proxy on :8643' },
  { key: 'hermesKey', label: 'Hermes API key', type: 'password' },
  { key: 'sttMode', label: 'Speech-to-text', options: ['proxy', 'elevenlabs', 'openai', 'deepgram'], hint: 'Live preview while talking: proxy (when the proxy uses Deepgram) or deepgram. elevenlabs/openai transcribe after you tap send.' },
  { key: 'sttKey', label: 'STT API key (direct modes)', type: 'password' },
  { key: 'sttUrl', label: 'STT base URL override', hint: 'OpenAI-compatible server, self-hosted Deepgram …' },
  { key: 'sttModel', label: 'STT model override', hint: 'scribe_v1 · whisper-1 · nova-3' },
  { key: 'sttLanguage', label: 'Language code (blank = auto)', hint: 'en, de, …' },
  { key: 'micSource', label: 'Microphone', options: ['glasses', 'phone'] },
  { key: 'typingSpeed', label: 'Typing speed', options: ['normal', 'slow', 'slowest', 'fast', 'off'], hint: 'Answers are revealed at a steady pace (slowest ≈ 6, slow ≈ 11, normal ≈ 18, fast ≈ 30 characters/s); off shows model output as it streams' },
  { key: 'scrollMode', label: 'Scrolling', options: ['page', 'smooth'], hint: 'page: the app redraws a page per swipe · smooth (experimental): the glasses scroll a multi-page window themselves, one line per swipe' },
  { key: 'pageTransition', label: 'Page turn (page mode)', options: ['fade', 'none'], hint: 'fade: the old page dims and the new one ramps up to full brightness · none: instant' },
  { key: 'scrollStep', label: 'Swipe scrolls by (page mode)', options: ['page', 'half'], hint: 'page: 8 lines per swipe (fewer redraws) · half: 5 lines (more continuity)' },
  { key: 'feedDetail', label: 'Transcript detail', options: ['compact', 'verbose'], hint: 'compact: tool + one argument, results only on failure · verbose: argument/result previews and reasoning' },
  { key: 'maxListenSeconds', label: 'Max listen seconds', type: 'number' },
  { key: 'minAudioRms', label: 'Silence threshold (RMS)', type: 'number', hint: 'Clips quieter than this are ignored' },
]

export function mountCompanion(root: HTMLElement, initial: Settings, cb: CompanionCallbacks): Companion {
  root.innerHTML = `
    <main class="panel">
      <header>
        <h1>Hermes G2</h1>
        <div id="bridge" class="chip chip-muted">bridge: waiting</div>
      </header>
      <section class="card">
        <div class="row"><span id="screen" class="chip">boot</span><span id="run" class="chip chip-muted">no run</span><span id="audio" class="chip chip-muted">audio: –</span></div>
        <div class="mirror-title">Glasses</div>
        <pre id="mirror" class="mirror">(nothing rendered yet)</pre>
        <form id="sendForm" class="row">
          <input id="sendText" type="text" placeholder="Type a message instead of talking…" autocomplete="off" />
          <button id="sendBtn" type="submit" class="secondary">Send</button>
        </form>
      </section>
      <section class="card">
        <h2>Settings</h2>
        <form id="settings"></form>
        <div class="row">
          <button id="save" type="button">Save &amp; apply</button>
          <button id="test" type="button" class="secondary">Test Hermes</button>
          <button id="reset" type="button" class="secondary">Reset</button>
        </div>
        <div id="testResult" class="test"></div>
      </section>
      <section class="card">
        <h2>Log</h2>
        <pre id="log" class="log"></pre>
      </section>
      <footer>Tap: talk / send · Swipe: scroll · Double-tap: back / exit · Tap-then-hold: menu (Stop run, New session, Sessions, Reconnect)</footer>
    </main>`
  injectStyles()

  const form = root.querySelector<HTMLFormElement>('#settings')!
  for (const f of FIELDS) {
    const wrap = document.createElement('label')
    wrap.className = 'field'
    const title = document.createElement('span')
    title.textContent = f.label
    wrap.appendChild(title)
    let input: HTMLInputElement | HTMLSelectElement
    if (f.options) {
      input = document.createElement('select')
      for (const o of f.options) {
        const opt = document.createElement('option')
        opt.value = o
        opt.textContent = o
        input.appendChild(opt)
      }
    } else {
      input = document.createElement('input')
      input.type = f.type ?? 'text'
      input.autocomplete = 'off'
      input.spellcheck = false
      ;(input as HTMLInputElement).autocapitalize = 'off'
    }
    input.name = f.key
    input.value = String(initial[f.key] ?? '')
    wrap.appendChild(input)
    if (f.hint) {
      const hint = document.createElement('small')
      hint.textContent = f.hint
      wrap.appendChild(hint)
    }
    form.appendChild(wrap)
  }

  const read = (): Settings => {
    const data = new FormData(form)
    const raw: Record<string, unknown> = {}
    for (const f of FIELDS) raw[f.key] = data.get(f.key)
    return normalizeSettings(raw as Partial<Settings>)
  }
  const fill = (s: Settings) => {
    for (const f of FIELDS) {
      const el = form.elements.namedItem(f.key) as HTMLInputElement | HTMLSelectElement | null
      if (el) el.value = String(s[f.key] ?? '')
    }
  }

  const logEl = root.querySelector<HTMLPreElement>('#log')!
  const lines: string[] = []
  const log = (line: string) => {
    const stamp = new Date().toTimeString().slice(0, 8)
    lines.push(`${stamp} ${line}`)
    if (lines.length > 300) lines.splice(0, lines.length - 300)
    logEl.textContent = lines.join('\n')
    logEl.scrollTop = logEl.scrollHeight
    console.log('[hermes-g2]', line)
  }

  const testEl = root.querySelector<HTMLDivElement>('#testResult')!
  root.querySelector<HTMLButtonElement>('#save')!.addEventListener('click', async () => {
    const s = read()
    fill(s)
    testEl.textContent = 'Saving…'
    try {
      await cb.onSave(s)
      testEl.textContent = 'Saved.'
      log('settings saved')
    } catch (err) {
      testEl.textContent = `Save failed: ${(err as Error).message}`
    }
  })
  root.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => fill(DEFAULT_SETTINGS))
  root.querySelector<HTMLButtonElement>('#test')!.addEventListener('click', async () => {
    const s = read()
    const client = new HermesClient({ baseUrl: s.hermesUrl, apiKey: s.hermesKey })
    const out: string[] = []
    const step = async (name: string, fn: () => Promise<string>) => {
      try {
        out.push(`✔ ${name}: ${await fn()}`)
      } catch (err) {
        out.push(`✘ ${name}: ${(err as Error).message}`)
      }
      testEl.textContent = out.join('\n')
    }
    testEl.textContent = 'Testing…'
    out.push(`· using ${s.hermesUrl} with a ${s.hermesKey.length}-character key`)
    await step('health', async () => (await client.health()).status ?? 'ok')
    await step('auth + capabilities', async () => {
      const caps = (await client.capabilities()) as { features?: Record<string, unknown>; model?: string }
      const f = caps.features ?? {}
      return `model=${caps.model ?? '?'} runs=${!!f.run_submission || !!f.run_events_sse} approvals=${!!f.approval_events}`
    })
    await step('sessions', async () => `${(await client.listSessions(5)).length} listed`)
    if (s.sttMode === 'proxy') {
      await step('proxy STT endpoint', async () => {
        const headers: Record<string, string> = {}
        if (s.hermesKey) headers.Authorization = `Bearer ${s.hermesKey}`
        const res = await fetch(`${s.hermesUrl}/proxy/health`, { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status} — is this the proxy, not the raw gateway?`)
        const j = (await res.json()) as { stt?: string; hermes?: string }
        return `stt=${j.stt ?? '?'} hermes=${j.hermes ?? '?'}`
      })
    }
    out.push('Note: the live event stream (/v1/runs/{id}/events) is only exercised by a real run. If sends "work" but nothing streams back, the gateway is missing CORS on that endpoint — point the app at the proxy.')
    testEl.textContent = out.join('\n')
  })

  const sendForm = root.querySelector<HTMLFormElement>('#sendForm')!
  const sendText = root.querySelector<HTMLInputElement>('#sendText')!
  sendForm.addEventListener('submit', async ev => {
    ev.preventDefault()
    const text = sendText.value.trim()
    if (!text || !cb.onSend) return
    sendText.value = ''
    try {
      await cb.onSend(text)
    } catch (err) {
      log(`send failed: ${(err as Error).message}`)
    }
  })

  const bridgeEl = root.querySelector<HTMLDivElement>('#bridge')!
  const screenEl = root.querySelector<HTMLSpanElement>('#screen')!
  const runEl = root.querySelector<HTMLSpanElement>('#run')!
  const audioEl = root.querySelector<HTMLSpanElement>('#audio')!
  const mirrorEl = root.querySelector<HTMLPreElement>('#mirror')!

  return {
    setBridgeState(text) {
      bridgeEl.textContent = `bridge: ${text}`
      bridgeEl.className = `chip ${/ready/.test(text) ? 'chip-ok' : 'chip-muted'}`
    },
    setSnapshot(snap) {
      screenEl.textContent = `${snap.screen}${snap.screen === 'chat' ? ` · ${snap.mode}` : ''}${snap.session ? ` · ${snap.session.title ?? snap.session.id}` : ''}`
      screenEl.className = `chip ${snap.mode === 'listening' ? 'chip-live' : 'chip-ok'}`
      runEl.textContent = snap.run ? `run ${snap.run.status}${snap.run.streaming ? ' (live)' : ''}` : 'no run'
      runEl.className = `chip ${snap.run && !/completed|failed|cancelled|interrupted/.test(snap.run.status) ? 'chip-live' : 'chip-muted'}`
      audioEl.textContent = snap.lastAudio
        ? `audio: ${snap.lastAudio.seconds}s rms ${snap.lastAudio.rms} peak ${snap.lastAudio.peak}`
        : 'audio: –'
    },
    setMirror(layout, containers) {
      mirrorEl.textContent = `[${layout}]\n` + Object.entries(containers).map(([k, v]) => `── ${k} ──\n${v}`).join('\n')
    },
    log,
  }
}

function injectStyles(): void {
  const css = `
    .panel { display: flex; flex-direction: column; gap: 14px; max-width: 680px; margin: 0 auto; padding: 20px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; }
    h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; color: #A7A7A7; text-transform: uppercase; letter-spacing: .04em; }
    .card { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 14px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
    .chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid #3E3E3E; color: #E5E5E5; }
    .chip-ok { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,.08); }
    .chip-live { color: #FFD60A; border-color: #FFD60A; background: rgba(255,214,10,.08); }
    .chip-muted { color: #A7A7A7; }
    .mirror-title { margin-top: 12px; font-size: 12px; color: #7B7B7B; }
    .mirror { background: #000; color: #3CFA44; border-radius: 8px; padding: 12px; font: 13px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; min-height: 120px; margin: 4px 0 0; }
    .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 13px; }
    .field span { color: #C7C7C7; }
    .field small { color: #7B7B7B; }
    #sendForm { margin-top: 10px; } #sendText { flex: 1; min-width: 0; }
    input, select { font: 15px system-ui, sans-serif; padding: 9px 10px; border-radius: 8px; border: 1px solid #3E3E3E; background: #232323; color: #E5E5E5; }
    button { font: 14px system-ui, sans-serif; padding: 9px 14px; border-radius: 8px; border: 1px solid #3CFA44; background: #3CFA44; color: #111; font-weight: 600; }
    button.secondary { background: transparent; color: #E5E5E5; border-color: #5A5A5A; }
    .test { white-space: pre-wrap; font-size: 13px; color: #C7C7C7; margin-top: 8px; }
    .log { font: 12px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; margin: 0; color: #C7C7C7; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
