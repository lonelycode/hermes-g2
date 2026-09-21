export type SttProviderName = 'elevenlabs' | 'openai' | 'deepgram'
export interface SttProviderConfig {
  provider: SttProviderName
  apiKey: string
  url?: string
  model?: string
  language?: string
}
export const STT_DEFAULTS: Record<SttProviderName, { url: string; model: string }>
export function transcribeWithProvider(
  wav: Blob | Uint8Array,
  cfg: SttProviderConfig,
  fetchImpl?: typeof fetch,
): Promise<string>
