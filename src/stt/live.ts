// Live (streaming) transcription while the user is still talking. Two transports:
//   proxy    -> ws(s)://<hermesUrl>/stt/stream relay (the proxy talks to Deepgram, key stays there)
//   deepgram -> straight to Deepgram's live API from the phone
// ElevenLabs / OpenAI batch modes have no live path; callers fall back to transcribePcm().

import { openDeepgramLive, type DeepgramLiveSession } from '../../shared/stt-live.mjs'
import type { Settings } from '../config.ts'

export interface LiveHandlers {
  onPartial(final: string, interim: string): void
  onError(message: string): void
}

export interface LiveSession {
  sendPcm(chunk: Uint8Array): void
  /** Flush and wait for the final transcript (bounded by `timeoutMs`). */
  finish(timeoutMs?: number): Promise<string>
  cancel(): void
  readonly failed: boolean
  readonly text: string
}

export function liveSupported(settings: Settings): boolean {
  return settings.sttMode === 'proxy' || settings.sttMode === 'deepgram'
}

export function startLiveTranscription(settings: Settings, handlers: LiveHandlers): LiveSession | null {
  if (settings.sttMode === 'deepgram') return startDirect(settings, handlers)
  if (settings.sttMode === 'proxy') return startRelay(settings, handlers)
  return null
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(fallback()), ms)
    p.then(v => {
      clearTimeout(t)
      resolve(v)
    })
  })
}

function startDirect(settings: Settings, handlers: LiveHandlers): LiveSession | null {
  let failed = false
  let resolveDone: ((s: string) => void) | null = null
  const done = new Promise<string>(r => (resolveDone = r))
  let session: DeepgramLiveSession
  try {
    session = openDeepgramLive(
      {
        apiKey: settings.sttKey,
        url: settings.sttUrl && /^wss?:/.test(settings.sttUrl) ? settings.sttUrl : undefined,
        model: settings.sttModel || undefined,
        language: settings.sttLanguage || undefined,
      },
      {
        onTranscript: t => handlers.onPartial(t.final, t.interim),
        onError: err => {
          failed = true
          handlers.onError((err as Error)?.message ?? String(err))
        },
        onClose: ({ final }) => resolveDone?.(final),
      },
    )
  } catch (err) {
    handlers.onError((err as Error).message)
    return null
  }
  return {
    sendPcm: c => session.sendPcm(c),
    finish: (timeoutMs = 4000) => {
      session.finish()
      return withTimeout(done, timeoutMs, () => session.text)
    },
    cancel: () => session.close(),
    get failed() {
      return failed
    },
    get text() {
      return session.text
    },
  }
}

function startRelay(settings: Settings, handlers: LiveHandlers): LiveSession | null {
  const base = settings.hermesUrl.replace(/^http/i, 'ws')
  const params = new URLSearchParams()
  if (settings.hermesKey) params.set('token', settings.hermesKey)
  if (settings.sttLanguage) params.set('language', settings.sttLanguage)
  let ws: WebSocket
  try {
    ws = new WebSocket(`${base}/stt/stream?${params}`)
  } catch (err) {
    handlers.onError(`live socket: ${(err as Error).message}`)
    return null
  }
  ws.binaryType = 'arraybuffer'
  let open = false
  let failed = false
  let finished = false
  let final = ''
  let interim = ''
  const queue: ArrayBuffer[] = []
  let resolveDone: ((s: string) => void) | null = null
  const done = new Promise<string>(r => (resolveDone = r))
  ws.onopen = () => {
    open = true
    for (const b of queue.splice(0)) ws.send(b)
    if (finished) ws.send(JSON.stringify({ type: 'finish' }))
  }
  ws.onmessage = ev => {
    let msg: { type?: string; final?: string; interim?: string; message?: string }
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.type === 'transcript') {
      final = msg.final ?? final
      interim = msg.interim ?? ''
      handlers.onPartial(final, interim)
    } else if (msg.type === 'done') {
      final = msg.final ?? final
      interim = ''
      resolveDone?.(final)
    } else if (msg.type === 'error') {
      failed = true
      handlers.onError(msg.message ?? 'live transcription error')
    }
  }
  ws.onerror = () => {
    failed = true
    handlers.onError('live socket failed (is the proxy reachable over ws://?)')
  }
  ws.onclose = () => {
    open = false
    resolveDone?.(final)
  }
  return {
    sendPcm: c => {
      if (finished) return
      const buf = c.slice().buffer as ArrayBuffer
      if (open) ws.send(buf)
      else queue.push(buf)
    },
    finish: (timeoutMs = 4000) => {
      finished = true
      if (open) ws.send(JSON.stringify({ type: 'finish' }))
      return withTimeout(done, timeoutMs, () => (interim ? `${final} ${interim}`.trim() : final))
    },
    cancel: () => {
      finished = true
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    },
    get failed() {
      return failed
    },
    get text() {
      return interim ? `${final} ${interim}`.trim() : final
    },
  }
}
