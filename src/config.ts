// App settings: persisted through the Even App bridge storage (survives relaunch and Android
// suspend), with window.localStorage as a fallback for the simulator / plain browsers.

export type SttMode = 'proxy' | 'elevenlabs' | 'openai' | 'deepgram'
export type MicSource = 'glasses' | 'phone'
/** compact: tool name + one argument, results only on failure. verbose: previews and reasoning. */
export type FeedDetail = 'compact' | 'verbose'
/** How far one swipe moves the transcript (page mode). */
export type ScrollStep = 'page' | 'half'
/** page: the app redraws a page per swipe. smooth: the glasses scroll a multi-page window natively. */
export type ScrollMode = 'page' | 'smooth'
/** Motion cue when a swipe turns the page (page mode). */
export type PageTransition = 'none' | 'slide' | 'fade' | 'blink'
/** Paced reveal of answers: off = show deltas as they arrive. */
export type TypingSpeed = 'off' | 'slow' | 'normal' | 'fast'

export interface Settings {
  hermesUrl: string
  hermesKey: string
  sttMode: SttMode
  sttUrl: string
  sttKey: string
  sttModel: string
  sttLanguage: string
  micSource: MicSource
  feedDetail: FeedDetail
  scrollStep: ScrollStep
  scrollMode: ScrollMode
  pageTransition: PageTransition
  typingSpeed: TypingSpeed
  maxListenSeconds: number
  /** RMS (0..32767) below which a clip counts as silence and is discarded. */
  minAudioRms: number
}

export const SETTINGS_KEY = 'hermes_g2_settings_v1'

const env = import.meta.env

export const DEFAULT_SETTINGS: Settings = {
  hermesUrl: env.VITE_HERMES_URL || 'http://127.0.0.1:8643',
  hermesKey: env.VITE_HERMES_KEY || '',
  sttMode: (env.VITE_STT_MODE as SttMode) || 'proxy',
  sttUrl: env.VITE_STT_URL || '',
  sttKey: env.VITE_STT_KEY || '',
  sttModel: env.VITE_STT_MODEL || '',
  sttLanguage: '',
  micSource: 'glasses',
  feedDetail: 'compact',
  scrollStep: 'page',
  scrollMode: 'page',
  pageTransition: 'slide',
  typingSpeed: 'normal',
  maxListenSeconds: 60,
  minAudioRms: 200,
}

export interface SettingsStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

/**
 * Storage backed by the Even bridge (sandboxed per plugin) when available. window.localStorage is
 * used only when there is no bridge (simulator / plain browser): inside the Even app the WebView
 * origin can be shared between a sideloaded dev page and an installed package, so falling back to
 * it would leak one install's settings into another.
 */
export function makeSettingsStore(bridge?: {
  getLocalStorage(key: string): Promise<string>
  setLocalStorage(key: string, value: string): Promise<boolean>
}): SettingsStore {
  if (!bridge) {
    return {
      async get(key) {
        try {
          return window.localStorage.getItem(key)
        } catch {
          return null
        }
      },
      async set(key, value) {
        try {
          window.localStorage.setItem(key, value)
        } catch {
          /* ignore */
        }
      },
    }
  }
  return {
    async get(key) {
      try {
        const v = await bridge.getLocalStorage(key)
        return typeof v === 'string' && v.length ? v : null
      } catch (err) {
        console.warn('[settings] bridge storage read failed', err)
        return null
      }
    },
    async set(key, value) {
      let ok = false
      try {
        ok = !!(await bridge.setLocalStorage(key, value))
      } catch (err) {
        console.warn('[settings] bridge storage write failed', err)
      }
      if (!ok) throw new Error('the Even app refused to store the settings')
    },
  }
}

export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...(raw || {}) }
  // An empty stored URL/key (e.g. saved before the env file existed) falls back to the dev defaults.
  s.hermesUrl = (s.hermesUrl || '').trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.hermesUrl
  s.hermesKey = (s.hermesKey || '').trim() || DEFAULT_SETTINGS.hermesKey
  s.sttUrl = s.sttUrl.trim().replace(/\/+$/, '')
  s.sttKey = s.sttKey.trim()
  s.sttModel = s.sttModel.trim()
  s.sttLanguage = s.sttLanguage.trim()
  if (!['proxy', 'elevenlabs', 'openai', 'deepgram'].includes(s.sttMode)) s.sttMode = 'proxy'
  if (!['glasses', 'phone'].includes(s.micSource)) s.micSource = 'glasses'
  if (!['compact', 'verbose'].includes(s.feedDetail)) s.feedDetail = 'compact'
  if (!['page', 'half'].includes(s.scrollStep)) s.scrollStep = 'page'
  if (!['page', 'smooth'].includes(s.scrollMode)) s.scrollMode = 'page'
  if (!['none', 'slide', 'fade', 'blink'].includes(s.pageTransition)) s.pageTransition = 'slide'
  if (!['off', 'slow', 'normal', 'fast'].includes(s.typingSpeed)) s.typingSpeed = 'normal'
  s.maxListenSeconds = clamp(Number(s.maxListenSeconds) || 60, 5, 300)
  s.minAudioRms = clamp(Number(s.minAudioRms) || 200, 0, 10000)
  return s
}

export async function loadSettings(store: SettingsStore): Promise<Settings> {
  const raw = await store.get(SETTINGS_KEY)
  if (!raw) return normalizeSettings(null)
  try {
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return normalizeSettings(null)
  }
}

export async function saveSettings(store: SettingsStore, settings: Settings): Promise<void> {
  await store.set(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)))
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
