// Streaming speech-to-text (Deepgram live) shared by the phone app (direct mode) and the proxy
// relay. Uses only the WHATWG WebSocket API, so it runs in the WebView and in Node 22+.
//
// The Deepgram socket authenticates through the `token` subprotocol, which works from browsers
// where custom headers are impossible.

export const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen'

/**
 * @typedef {Object} LiveConfig
 * @property {string} apiKey
 * @property {string} [url]      Base wss:// URL override
 * @property {string} [model]    default nova-3
 * @property {string} [language] ISO code; empty = auto/multi
 */

export function deepgramLiveUrl(cfg) {
  const base = String(cfg.url || DEEPGRAM_LIVE_URL).replace(/\/+$/, '')
  const params = new URLSearchParams({
    model: cfg.model || 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    endpointing: '300',
  })
  if (cfg.language) params.set('language', cfg.language)
  return `${base}?${params}`
}

/**
 * Accumulates Deepgram "Results" messages into a stable final text plus an unstable interim tail.
 * Pure, so it can be unit-tested without a socket.
 */
export class TranscriptAccumulator {
  constructor() {
    this.final = ''
    this.interim = ''
  }
  /** @param {any} msg parsed Deepgram message; returns true when the transcript changed */
  ingest(msg) {
    if (!msg || msg.type !== 'Results') return false
    const alt = msg.channel?.alternatives?.[0]
    const text = String(alt?.transcript ?? '').trim()
    if (msg.is_final) {
      if (text) this.final = this.final ? `${this.final} ${text}` : text
      const changed = !!text || !!this.interim
      this.interim = ''
      return changed
    }
    if (text === this.interim) return false
    this.interim = text
    return true
  }
  get text() {
    return this.interim ? (this.final ? `${this.final} ${this.interim}` : this.interim) : this.final
  }
}

/**
 * Open a Deepgram live session.
 * @param {LiveConfig} cfg
 * @param {{ onTranscript?: (s: {final: string, interim: string}) => void, onError?: (e: unknown) => void,
 *           onClose?: (s: {final: string}) => void, onOpen?: () => void }} handlers
 * @param {typeof WebSocket} [WS]
 */
export function openDeepgramLive(cfg, handlers, WS = globalThis.WebSocket) {
  if (!cfg.apiKey) throw new Error('Deepgram API key missing')
  if (!WS) throw new Error('WebSocket is not available in this runtime')
  const ws = new WS(deepgramLiveUrl(cfg), ['token', cfg.apiKey])
  ws.binaryType = 'arraybuffer'
  const acc = new TranscriptAccumulator()
  let open = false
  let finished = false
  const queue = []
  ws.onopen = () => {
    open = true
    for (const chunk of queue.splice(0)) ws.send(chunk)
    if (finished) ws.send(JSON.stringify({ type: 'CloseStream' }))
    handlers.onOpen?.()
  }
  ws.onmessage = ev => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data))
    } catch {
      return
    }
    handlers.onRaw?.(msg)
    if (msg.type === 'Error' || msg.error) {
      handlers.onError?.(new Error(msg.description || msg.message || msg.error || 'Deepgram error'))
      return
    }
    if (acc.ingest(msg)) handlers.onTranscript?.({ final: acc.final, interim: acc.interim })
  }
  ws.onerror = ev => handlers.onError?.(ev instanceof Error ? ev : new Error(`Deepgram socket error${ev?.message ? `: ${ev.message}` : ''}`))
  ws.onclose = ev => {
    open = false
    handlers.onClose?.({ final: acc.final, code: ev?.code, reason: ev?.reason })
  }
  return {
    /** @param {Uint8Array|ArrayBuffer} pcm */
    sendPcm(pcm) {
      if (finished) return
      // Node Buffers are views onto a shared pool, so `.buffer` alone would send the whole slab.
      const buf = pcm instanceof Uint8Array ? pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) : pcm
      if (open) ws.send(buf)
      else queue.push(buf)
    },
    /** Ask Deepgram to flush pending results and close. */
    finish() {
      if (finished) return
      finished = true
      if (open) ws.send(JSON.stringify({ type: 'CloseStream' }))
    },
    close() {
      finished = true
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    },
    get text() {
      return acc.text
    },
    get final() {
      return acc.final
    },
  }
}
