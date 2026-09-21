// Speech-to-text provider adapters shared by the app (browser) and proxy/server.mjs (Node 20+).
// Every adapter takes a WAV (16 kHz, mono, s16le) as a Blob/Uint8Array and resolves to plain text.
// Only web-standard APIs are used (fetch, FormData, Blob) so the same code runs in both places.

/**
 * @typedef {Object} SttProviderConfig
 * @property {'elevenlabs'|'openai'|'deepgram'} provider
 * @property {string} apiKey
 * @property {string} [url]       Base URL override (OpenAI-compatible servers, self-hosted Deepgram, ...)
 * @property {string} [model]
 * @property {string} [language]  ISO-639-1 like "en"; empty = auto-detect
 */

export const STT_DEFAULTS = {
  elevenlabs: { url: 'https://api.elevenlabs.io', model: 'scribe_v1' },
  openai: { url: 'https://api.openai.com', model: 'whisper-1' },
  deepgram: { url: 'https://api.deepgram.com', model: 'nova-3' },
}

function trimSlash(u) {
  return String(u || '').replace(/\/+$/, '')
}

function toBlob(wav) {
  if (typeof Blob !== 'undefined' && wav instanceof Blob) return wav
  return new Blob([wav], { type: 'audio/wav' })
}

async function readError(res) {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 300)
  } catch {
    /* ignore */
  }
  return new Error(`STT HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
}

/**
 * Transcribe a WAV clip with the configured provider.
 * @param {Blob|Uint8Array} wav
 * @param {SttProviderConfig} cfg
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function transcribeWithProvider(wav, cfg, fetchImpl = fetch) {
  const provider = cfg.provider
  const defaults = STT_DEFAULTS[provider]
  if (!defaults) throw new Error(`Unknown STT provider: ${provider}`)
  if (!cfg.apiKey) throw new Error(`STT API key missing for ${provider}`)
  const base = trimSlash(cfg.url || defaults.url)
  const model = cfg.model || defaults.model
  const language = (cfg.language || '').trim()
  const blob = toBlob(wav)

  if (provider === 'elevenlabs') {
    const form = new FormData()
    form.append('model_id', model)
    form.append('file', blob, 'clip.wav')
    form.append('tag_audio_events', 'false')
    form.append('diarize', 'false')
    if (language) form.append('language_code', language)
    const res = await fetchImpl(`${base}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey },
      body: form,
    })
    if (!res.ok) throw await readError(res)
    const json = await res.json()
    return String(json.text || '').trim()
  }

  if (provider === 'openai') {
    const form = new FormData()
    form.append('model', model)
    form.append('file', blob, 'clip.wav')
    form.append('response_format', 'json')
    if (language) form.append('language', language)
    const res = await fetchImpl(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    })
    if (!res.ok) throw await readError(res)
    const json = await res.json()
    return String(json.text || '').trim()
  }

  // deepgram
  const params = new URLSearchParams({ model, smart_format: 'true' })
  if (language) params.set('language', language)
  const res = await fetchImpl(`${base}/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${cfg.apiKey}`, 'Content-Type': 'audio/wav' },
    body: blob,
  })
  if (!res.ok) throw await readError(res)
  const json = await res.json()
  const alt = json?.results?.channels?.[0]?.alternatives?.[0]
  return String(alt?.transcript || '').trim()
}
