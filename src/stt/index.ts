import { transcribeWithProvider } from '../../shared/stt-providers.mjs'
import type { Settings } from '../config.ts'
import { pcmToWav } from './wav.ts'

/**
 * Transcribe a finished PCM clip. In `proxy` mode the clip goes to the bundled proxy
 * (`<hermesUrl>/stt/transcribe`) which keeps the STT key server-side; the other modes call the
 * provider directly from the phone with the key stored in app settings.
 */
export async function transcribePcm(pcm: Uint8Array, settings: Settings): Promise<string> {
  const wav = pcmToWav(pcm)
  if (settings.sttMode === 'proxy') {
    const params = new URLSearchParams()
    if (settings.sttLanguage) params.set('language', settings.sttLanguage)
    const qs = params.toString()
    const headers: Record<string, string> = { 'Content-Type': 'audio/wav' }
    if (settings.hermesKey) headers.Authorization = `Bearer ${settings.hermesKey}`
    const res = await fetch(`${settings.hermesUrl}/stt/transcribe${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      headers,
      body: new Blob([wav as unknown as ArrayBuffer], { type: 'audio/wav' }),
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        /* ignore */
      }
      throw new Error(`Proxy STT HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    const json = (await res.json()) as { text?: string }
    return String(json.text || '').trim()
  }
  return transcribeWithProvider(wav, {
    provider: settings.sttMode,
    apiKey: settings.sttKey,
    url: settings.sttUrl || undefined,
    model: settings.sttModel || undefined,
    language: settings.sttLanguage || undefined,
  })
}
