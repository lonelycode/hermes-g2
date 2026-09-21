export const DEEPGRAM_LIVE_URL: string
export interface LiveConfig {
  apiKey: string
  url?: string
  model?: string
  language?: string
}
export interface LiveTranscript {
  final: string
  interim: string
}
export class TranscriptAccumulator {
  final: string
  interim: string
  ingest(msg: unknown): boolean
  readonly text: string
}
export interface LiveHandlers {
  onTranscript?(s: LiveTranscript): void
  onError?(e: unknown): void
  onClose?(s: { final: string; code?: number; reason?: string }): void
  onOpen?(): void
  onRaw?(msg: unknown): void
}
export interface DeepgramLiveSession {
  sendPcm(pcm: Uint8Array | ArrayBuffer): void
  finish(): void
  close(): void
  readonly text: string
  readonly final: string
}
export function deepgramLiveUrl(cfg: LiveConfig): string
export function openDeepgramLive(cfg: LiveConfig, handlers: LiveHandlers, WS?: typeof WebSocket): DeepgramLiveSession
