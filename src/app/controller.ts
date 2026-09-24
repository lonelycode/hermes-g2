// The app state machine: menu (session list) ⇄ chat (feed + voice) ⇄ approval overlay.
// Owns the Hermes client, per-session feeds, run trackers, microphone capture and the mapping
// from ring/temple gestures to actions.

import { AppLocationAccuracy, AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Settings } from '../config.ts'
import { HermesClient, HermesError } from '../hermes/client.ts'
import {
  TERMINAL_EVENTS,
  TERMINAL_STATUSES,
  type ApprovalChoice,
  type ApprovalRequestEvent,
  type HermesMessage,
  type HermesSession,
  type RunEvent,
  type RunStatus,
} from '../hermes/types.ts'
import { transcribePcm } from '../stt/index.ts'
import { startLiveTranscription, type LiveSession } from '../stt/live.ts'
import { concatChunks, pcmStats } from '../stt/wav.ts'
import { APPROVAL_BODY_LINES, BODY_LINES, Glasses, INNER_W, MENU_ITEMS, MENU_OBJECT } from '../glasses/display.ts'
import type { Gesture } from '../glasses/input.ts'
import { approxCharsPerLine, fitLine, oneLine, plainify, wrapText } from '../glasses/text.ts'
import { renderChart } from '../glasses/chart.ts'
import { extractCharts, type ChartSpec } from './charts.ts'
import { Feed, type FeedEntry } from './feed.ts'
import { looksLikeError, summarizeToolCall, summarizeToolResult } from './summaries.ts'
import { buildInstructions, type LocationFix } from './context.ts'
import { cleanUserRow } from './history.ts'
import { TYPING_CPS, revealWords } from './typewriter.ts'

export type Screen = 'boot' | 'error' | 'menu' | 'chat' | 'approval' | 'chart' | 'hidden'
export type ChatMode = 'idle' | 'listening' | 'transcribing' | 'sending'

interface RunTracker {
  runId: string
  sessionId: string
  status: RunStatus['status']
  abort: AbortController
  streaming: boolean
  /** 'connecting' until the SSE stream opens, then 'streaming'; 'polling' after a stream loss. */
  link: 'connecting' | 'streaming' | 'polling'
  assistant?: FeedEntry
  lastActivity: string
  approvalIds: Set<string>
  /** Raw streamed answer text (typing mode reveals a prefix of it). */
  streamed?: string
  /** The user stopped this run from the glasses. */
  interrupted?: boolean
  /** Chart attached to this run's answer (a g2chart block). */
  chart?: ChartSpec
}

interface PendingApproval {
  tracker: RunTracker
  event: ApprovalRequestEvent
}

interface ApprovalView extends PendingApproval {
  cursor: number
}

export interface ControllerSnapshot {
  screen: Screen
  mode: ChatMode
  session: HermesSession | null
  run: { runId: string; status: string; streaming: boolean } | null
  listeningSeconds: number
  lastAudio: { seconds: number; rms: number; peak: number } | null
}

export interface ControllerDeps {
  bridge: EvenAppBridge
  glasses: Glasses
  settings: Settings
  log(line: string): void
  onSnapshot?(snap: ControllerSnapshot): void
}

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: 'Allow once',
  session: 'Allow this session',
  always: 'Always allow',
  deny: 'Deny',
}

const NEW_SESSION_LABEL = '+ New session'
// Smooth-scroll window: the glasses scroll this natively; we only swap it at the edges.
const WINDOW_LINES = 40
const WINDOW_CHARS = 1900
const POLL_MS = 2000
const POLL_MAX_MS = 6 * 60 * 60 * 1000
// A location fix younger than this is reused; an older one is refreshed before the next send.
const LOCATION_FRESH_MS = 5 * 60 * 1000
// How long a send waits for a location fix before going without one.
const LOCATION_WAIT_MS = 2500

export class Controller {
  private client: HermesClient
  private settings: Settings
  private screen: Screen = 'boot'
  private mode: ChatMode = 'idle'
  private sessions: HermesSession[] = []
  private session: HermesSession | null = null
  private feeds = new Map<string, Feed>()
  private runs = new Map<string, RunTracker>()
  private pendingApprovals = new Map<string, PendingApproval>()
  private approval: ApprovalView | null = null
  private chunks: Uint8Array[] = []
  private chunkBytes = 0
  private live: LiveSession | null = null
  private draft: FeedEntry | null = null
  /** Smooth mode: first line of the window currently on the glasses, per session. */
  private winStart = new Map<string, number>()
  private winEnd = 0
  /** Typing mode: full text received so far per answer entry; the entry shows a paced prefix. */
  private typing = new Map<number, { entry: FeedEntry; sessionId: string; target: string; done: boolean; budget: number }>()
  private typeLoopRunning = false
  private listenStart = 0
  private listenTimer: number | null = null
  private tickTimer: number | null = null
  private spinTimer: number | null = null
  private spinFrame = 0
  private lastAudio: ControllerSnapshot['lastAudio'] = null
  private stopped = false
  private lastError = ''
  /** Sessions opened on the glasses but not yet created on the gateway (created on first send). */
  private unsaved = new Set<string>()
  private location: LocationFix | null = null
  private locationAt = 0
  private locating: Promise<void> | null = null
  /** Latest chart per session (reopened from the "Last chart" menu item). */
  private lastChart = new Map<string, ChartSpec>()
  /** Chart to open once its answer has finished revealing, per session. */
  private chartDue = new Map<string, ChartSpec>()
  /** Where a long press hid the app from (the screen to bring back). */
  private hiddenFrom: Screen = 'chat'

  constructor(private readonly deps: ControllerDeps) {
    this.settings = deps.settings
    this.client = this.makeClient()
  }

  private makeClient(): HermesClient {
    return new HermesClient({ baseUrl: this.settings.hermesUrl, apiKey: this.settings.hermesKey })
  }

  private get glasses(): Glasses {
    return this.deps.glasses
  }

  private log(line: string): void {
    this.deps.log(line)
  }

  snapshot(): ControllerSnapshot {
    const tracker = this.session ? this.runs.get(this.session.id) : undefined
    return {
      screen: this.screen,
      mode: this.mode,
      session: this.session,
      run: tracker ? { runId: tracker.runId, status: tracker.status, streaming: tracker.streaming } : null,
      listeningSeconds: this.mode === 'listening' ? Math.floor((Date.now() - this.listenStart) / 1000) : 0,
      lastAudio: this.lastAudio,
    }
  }

  private emit(): void {
    this.deps.onSnapshot?.(this.snapshot())
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  async start(): Promise<void> {
    this.screen = 'boot'
    this.emit()
    await this.glasses.showMessage(`Hermes G2\n\nConnecting to\n${this.settings.hermesUrl} …`)
    try {
      await this.client.health()
      await this.client.capabilities()
    } catch (err) {
      await this.showError(err)
      return
    }
    if (this.settings.shareLocation === 'on') void this.refreshLocation()
    if (this.settings.launchInto === 'new') return this.newSession()
    if (this.settings.launchInto === 'latest') {
      try {
        const latest = (await this.client.listSessions(5)).find(s => !s.archived)
        if (latest) {
          this.sessions = [latest]
          return this.enterChat(latest, false)
        }
        return this.newSession()
      } catch (err) {
        this.log(`listSessions failed: ${(err as Error).message}`)
      }
    }
    await this.showMenu()
  }

  async applySettings(settings: Settings): Promise<void> {
    this.settings = settings
    this.client = this.makeClient()
    if (settings.shareLocation === 'off') this.location = null
    this.log(`settings applied: ${settings.hermesUrl}`)
    if (this.screen === 'error' || this.screen === 'boot') await this.start()
  }

  /** Called on SYSTEM_EXIT / ABNORMAL_EXIT and page unload. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.clearAllTimers()
    try {
      await this.deps.bridge.audioControl(false)
    } catch {
      /* ignore */
    }
    for (const t of this.runs.values()) t.abort.abort()
  }

  private async showError(err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err)
    this.lastError = msg
    this.log(`error: ${msg}`)
    this.screen = 'error'
    this.emit()
    const hint =
      err instanceof HermesError && err.status === 403
        ? 'HTTP 403: the gateway rejects browser origins. Set API_SERVER_CORS_ORIGINS=* on it, or point the app at the proxy.'
        : err instanceof HermesError && err.kind === 'auth'
          ? 'Check the API key in the phone app.'
          : 'Set the gateway URL and key in the phone app.'
    const body = wrapText(`× Hermes unreachable\n${this.settings.hermesUrl}\n${msg}\n${hint}\n\nTap: retry · Double-tap: exit`, INNER_W)
      .slice(0, 10)
      .join('\n')
    await this.glasses.showMessage(body)
  }

  // ---- menu ----------------------------------------------------------------------------------

  private async showMenu(): Promise<void> {
    this.screen = 'menu'
    this.approval = null
    this.syncSpinner()
    this.emit()
    let items: string[] = [NEW_SESSION_LABEL]
    let header = 'HERMES · sessions'
    try {
      this.sessions = (await this.client.listSessions(19)).filter(s => !s.archived)
      items = [NEW_SESSION_LABEL, ...this.sessions.map(s => this.sessionLabel(s))]
    } catch (err) {
      this.sessions = []
      header = 'HERMES · sessions (list failed)'
      this.log(`listSessions failed: ${(err as Error).message}`)
    }
    const pending = this.pendingApprovals.size
    const active = [...this.runs.values()].filter(t => !TERMINAL_STATUSES.has(t.status)).length
    if (pending) header = `HERMES · ${pending} approval${pending > 1 ? 's' : ''} waiting`
    else if (active) header = `HERMES · ${active} run${active > 1 ? 's' : ''} in progress`
    await this.glasses.showList({ header, items }, MENU_OBJECT)
  }

  private sessionLabel(s: HermesSession): string {
    const base = (s.title || s.preview || s.id || '').trim() || s.id
    const tracker = this.runs.get(s.id)
    const mark = this.pendingApprovals.has(s.id) ? '? ' : tracker && !TERMINAL_STATUSES.has(tracker.status) ? '◌ ' : ''
    return fitLine(mark + base, 540)
  }

  private async newSession(): Promise<void> {
    const now = new Date()
    const title = `G2 ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${now
      .toTimeString()
      .slice(0, 5)}`
    // Created on the gateway only once something is sent, so opening the app (or a new
    // session) without talking leaves no empty sessions behind.
    const session: HermesSession = { id: `g2_${Date.now().toString(36)}`, title }
    this.unsaved.add(session.id)
    this.sessions.unshift(session)
    await this.enterChat(session, true)
  }

  /** Create a lazily opened session on the gateway, carrying its feed over to the real id. */
  private async saveSession(session: HermesSession): Promise<void> {
    if (!this.unsaved.delete(session.id)) return
    let created: HermesSession
    try {
      created = await this.client.createSession(session.title ?? '')
    } catch (err) {
      // Older gateways may lack POST /api/sessions; /v1/runs auto-creates the session anyway.
      this.log(`createSession failed, using client id: ${(err as Error).message}`)
      return
    }
    const oldId = session.id
    if (created.id === oldId) return
    const feed = this.feeds.get(oldId)
    if (feed) {
      this.feeds.delete(oldId)
      this.feeds.set(created.id, feed)
    }
    const win = this.winStart.get(oldId)
    if (win !== undefined) {
      this.winStart.delete(oldId)
      this.winStart.set(created.id, win)
    }
    // Same object as this.session / this.sessions[i], so every holder sees the new id.
    Object.assign(session, created)
  }

  // ---- context for the agent -------------------------------------------------------------------

  /** Ask the phone for a location fix; failures and timeouts just leave the last fix in place. */
  private refreshLocation(): Promise<void> {
    if (this.locating) return this.locating
    this.locating = (async () => {
      try {
        // Hosts without location support may never answer; don't let that pin `locating`.
        const fix = await Promise.race([
          this.deps.bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 10000 }),
          sleep(12000).then(() => null),
        ])
        if (fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)) {
          // The host may report seconds or milliseconds.
          const ts = fix.timestamp ? (fix.timestamp < 1e12 ? fix.timestamp * 1000 : fix.timestamp) : Date.now()
          this.location = { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, timestamp: ts }
          this.locationAt = Date.now()
        }
      } catch (err) {
        this.log(`location unavailable: ${(err as Error).message}`)
      } finally {
        this.locating = null
      }
    })()
    return this.locating
  }

  private async runInstructions(): Promise<string> {
    let location: LocationFix | null = null
    if (this.settings.shareLocation === 'on') {
      if (!this.location || Date.now() - this.locationAt > LOCATION_FRESH_MS) {
        await Promise.race([this.refreshLocation(), sleep(LOCATION_WAIT_MS)])
      }
      location = this.location
    }
    let timeZone: string | undefined
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      /* device offset only */
    }
    return buildInstructions({
      now: new Date(),
      timeZone,
      lines: BODY_LINES,
      charsPerLine: approxCharsPerLine(INNER_W),
      location,
      charts: this.settings.charts === 'on',
    })
  }

  private async openSession(index: number): Promise<void> {
    const session = this.sessions[index]
    if (!session) return
    await this.enterChat(session, false)
  }

  // ---- chat ----------------------------------------------------------------------------------

  private feed(sessionId = this.session?.id ?? ''): Feed {
    let f = this.feeds.get(sessionId)
    if (!f) {
      f = new Feed(INNER_W, BODY_LINES)
      this.feeds.set(sessionId, f)
    }
    f.step = this.settings.scrollStep === 'half' ? Math.ceil(BODY_LINES / 2) : BODY_LINES - 1
    f.collapseTools = this.settings.toolSteps === 'collapsed'
    return f
  }

  private async enterChat(session: HermesSession, fresh: boolean): Promise<void> {
    this.session = session
    this.screen = 'chat'
    this.mode = 'idle'
    this.emit()
    const feed = this.feed(session.id)
    if (!fresh && !feed.entries.length) {
      await this.glasses.showChat({ body: 'Loading history…', status: this.statusLine() })
      try {
        const messages = await this.client.getMessages(session.id, 60)
        this.loadHistory(feed, messages, session.id)
      } catch (err) {
        feed.add('error', `history unavailable: ${(err as Error).message}`)
      }
      feed.jumpToEnd()
    }
    if (fresh && !feed.entries.length) {
      feed.add('system', `${session.title ?? 'New session'} — tap to talk`)
    }
    await this.glasses.showChat({ body: this.bodyText(), status: this.statusLine() })
    const pending = this.pendingApprovals.get(session.id)
    if (pending) await this.presentApproval(pending)
  }

  private loadHistory(feed: Feed, messages: HermesMessage[], sessionId: string): void {
    for (const m of messages) {
      const content = messageText(m)
      if (m.role === 'user') {
        const row = cleanUserRow(content, m.display_kind)
        if (!row) continue
        if (row.steer) feed.add('system', `steer: ${plainify(row.text)}`)
        else feed.add('user', plainify(row.text))
      } else if (m.role === 'assistant') {
        for (const call of m.tool_calls ?? []) {
          const name = call.function?.name ?? 'tool'
          feed.add('tool', summarizeToolCall(name, call.function?.arguments), { tool: name, done: true })
        }
        if (content) feed.add('assistant', this.answerText(sessionId, content))
      }
    }
  }

  /** Is anything in flight for the visible session (drives the status-bar animation)? */
  private busy(): boolean {
    if (this.mode === 'transcribing' || this.mode === 'sending' || this.mode === 'listening') return true
    if (this.session && this.typingFor(this.session.id)) return true
    const tracker = this.session ? this.runs.get(this.session.id) : undefined
    return !!tracker && !TERMINAL_STATUSES.has(tracker.status)
  }

  private spinner(): string {
    const frames = ['●○○', '○●○', '○○●', '○●○']
    return frames[this.spinFrame % frames.length]
  }

  /** Keep the status bar animating while something is in flight; stops itself when idle. */
  private syncSpinner(): void {
    const want = this.screen === 'chat' && this.busy()
    if (want && this.spinTimer === null) {
      this.spinTimer = window.setInterval(() => {
        this.spinFrame++
        // While an answer is being revealed the body write cadence already animates the
        // display; keep the status bar to one write per two ticks to spare the link.
        const revealing = !!this.session && this.typingFor(this.session.id)
        if (this.screen === 'chat' && (!revealing || this.spinFrame % 2 === 0)) this.glasses.updateStatus(this.statusLine())
        if (!this.busy()) this.syncSpinner()
      }, 500)
    } else if (!want && this.spinTimer !== null) {
      window.clearInterval(this.spinTimer)
      this.spinTimer = null
    }
  }

  private statusLine(): string {
    const feed = this.feed()
    const pos = feed.position()
    const where = this.smooth
      ? `${(this.winStart.get(this.session?.id ?? '') ?? 0) > 0 ? '↑' : ''}${this.winEnd < feed.lines().length ? '↓' : ''}`.replace(/(.)/, '$1 ')
      : pos.pages > 1
        ? `${pos.page}/${pos.pages}${pos.atEnd ? '' : '↓'} `
        : ''
    const spin = this.spinner()
    if (this.mode === 'listening') {
      const s = Math.floor((Date.now() - this.listenStart) / 1000)
      const mic = this.spinFrame % 2 ? '●' : '○' // blinking record dot
      const live = this.live ? (this.live.failed ? ' · no live preview' : '') : ''
      return `${mic} Listening ${s}s${live} · tap: send · double: cancel`
    }
    if (this.mode === 'transcribing') return `${spin} Transcribing… ${where}`
    if (this.mode === 'sending') return `${spin} Sending to Hermes… ${where}`
    const tracker = this.session ? this.runs.get(this.session.id) : undefined
    if (this.pendingApprovals.has(this.session?.id ?? '')) return `? Approval needed · tap: review`
    if (this.session && this.typingFor(this.session.id) && (!tracker || TERMINAL_STATUSES.has(tracker.status))) {
      return `${spin} replying… · ${where}double: stop`
    }
    if (tracker && !TERMINAL_STATUSES.has(tracker.status)) {
      const state =
        tracker.status === 'waiting_for_approval'
          ? 'waiting for approval'
          : tracker.link === 'connecting'
            ? 'connecting…'
            : tracker.lastActivity
              ? fitLine(tracker.lastActivity, 260)
              : tracker.link === 'polling'
                ? 'working (polling)'
                : 'thinking…'
      return `${spin} ${state} · ${where}tap: steer · double: stop`
    }
    return `${where}tap: talk · ↑↓ scroll · double: menu · hold: hide`
  }

  private get smooth(): boolean {
    return this.settings.scrollMode === 'smooth'
  }

  /** Text for the body container: one page, or (smooth mode) a native-scrollable window. */
  private bodyText(): string {
    const feed = this.feed()
    if (!this.smooth) return feed.page()
    const sessionId = this.session?.id ?? ''
    const total = feed.lines().length
    let start = this.winStart.get(sessionId)
    const anchor = feed.anchorLine()
    if (feed.anchored && anchor !== null) start = Math.max(anchor, total - BODY_LINES)
    else if (feed.follow || start === undefined) start = Math.max(0, total - BODY_LINES)
    start = Math.max(0, Math.min(start, Math.max(0, total - 1)))
    const view = feed.viewport(start, WINDOW_LINES, WINDOW_CHARS)
    this.winStart.set(sessionId, view.start)
    this.winEnd = view.end
    return view.text
  }

  /** Smooth mode: the glasses deliver swipe events only at the window edges; move the window. */
  private shiftWindow(direction: 'up' | 'down'): boolean {
    const feed = this.feed()
    const sessionId = this.session?.id ?? ''
    const total = feed.lines().length
    const start = this.winStart.get(sessionId) ?? Math.max(0, total - BODY_LINES)
    feed.releaseAnchor()
    if (direction === 'down') {
      if (this.winEnd >= total) {
        feed.follow = true
        return false
      }
      feed.follow = false
      // The last visible lines become the top of the new window (a content update resets the
      // scroll position to the top), so reading continues without a gap.
      this.winStart.set(sessionId, Math.max(0, this.winEnd - (BODY_LINES - 1)))
      return true
    }
    if (start <= 0) return false
    feed.follow = false
    // Going back has to be a page jump (the firmware shows the top of any new content); keep one
    // line of overlap so the line being read stays on screen, and extend the window forward so
    // reading down again is native.
    this.winStart.set(sessionId, Math.max(0, start - (BODY_LINES - 1)))
    return true
  }

  /** Page mode: move from one line offset to another with the configured motion cue. */
  private turnPage(from: number, to: number): void {
    const feed = this.feed()
    const target = feed.page()
    if (this.settings.pageTransition === 'fade' && to !== from) {
      // Dip the old page, bring the new one in dim, then ramp to full brightness.
      this.glasses.animateBody(
        [
          { content: feed.pageAt(from), textColor: 1 },
          { content: target, textColor: 2 },
          { content: target, textColor: 3 },
          { content: target, textColor: 4 },
        ],
        130,
      )
    } else {
      this.glasses.updateBody(target)
    }
    this.glasses.updateStatus(this.statusLine())
    this.syncSpinner()
    this.emit()
  }

  private render(sessionId?: string): void {
    if (this.screen !== 'chat' || !this.session) return
    if (sessionId && sessionId !== this.session.id) return
    this.glasses.updateBody(this.bodyText())
    this.glasses.updateStatus(this.statusLine())
    this.syncSpinner()
    this.emit()
  }

  private async goToMenu(): Promise<void> {
    if (this.mode === 'listening') await this.cancelListening()
    this.session = null
    await this.showMenu()
  }

  // ---- microphone ------------------------------------------------------------------------------

  handleAudio(pcm: Uint8Array): void {
    if (this.mode !== 'listening') return
    const cap = this.settings.maxListenSeconds * 32000
    if (this.chunkBytes + pcm.byteLength > cap) return
    this.chunks.push(pcm)
    this.chunkBytes += pcm.byteLength
    this.live?.sendPcm(pcm)
  }

  /** Show the live transcript as the pending user turn at the bottom of the feed. */
  private showDraft(final: string, interim: string): void {
    if (this.mode !== 'listening' && this.mode !== 'transcribing') return
    const text = interim ? `${final} ${interim}…`.trim() : final
    const feed = this.feed()
    if (!this.draft) this.draft = feed.add('user', text)
    else feed.update(this.draft, { text })
    feed.jumpToEnd()
    this.render()
  }

  private dropDraft(): void {
    if (this.draft) this.feed().remove(this.draft)
    this.draft = null
  }

  private clearListenTimers(): void {
    if (this.listenTimer !== null) window.clearTimeout(this.listenTimer)
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer)
    this.listenTimer = this.tickTimer = null
  }

  /** Stop every timer (exit). */
  private clearAllTimers(): void {
    this.clearListenTimers()
    if (this.spinTimer !== null) window.clearInterval(this.spinTimer)
    this.spinTimer = null
    this.typing.clear()
  }

  // ---- paced answer reveal ----------------------------------------------------------------------

  private typingCps(): number {
    return TYPING_CPS[this.settings.typingSpeed] ?? 0
  }

  /** Route answer text through the typewriter (or straight to the entry when typing is off). */
  private setAnswerText(sessionId: string, entry: FeedEntry, text: string, done: boolean): void {
    const feed = this.feed(sessionId)
    if (!this.typingCps()) {
      feed.update(entry, { text })
      return
    }
    const job = this.typing.get(entry.id) ?? { entry, sessionId, target: '', done: false, budget: 0 }
    job.target = text
    job.done = done
    this.typing.set(entry.id, job)
    void this.typeLoop()
  }

  /**
   * Reveal loop paced by the display: each step advances by the characters the elapsed time is
   * worth at the chosen speed, writes the page, and waits for the bridge to accept it before the
   * next step. On slow BLE links that yields fewer, larger steps at the same average speed
   * instead of a backlog that lands in lumps.
   */
  private async typeLoop(): Promise<void> {
    if (this.typeLoopRunning) return
    this.typeLoopRunning = true
    const MIN_STEP_MS = 260
    let last = Date.now() - MIN_STEP_MS
    try {
      while (this.typing.size && !this.stopped) {
        const now = Date.now()
        const dt = Math.min(1000, now - last)
        last = now
        const earned = (this.typingCps() * dt) / 1000
        let visibleSession: string | null = null
        const revealed: string[] = []
        for (const [id, job] of this.typing) {
          const feed = this.feed(job.sessionId)
          // Budget accrues at the chosen speed and is capped so a pause never turns into a burst.
          job.budget = Math.min(job.budget + earned, Math.max(20, this.typingCps()))
          const r = revealWords(job.entry.text, job.target, job.budget)
          job.budget -= r.spent
          if (r.text !== job.entry.text) feed.update(job.entry, { text: r.text })
          if (job.entry.text === job.target && job.done) {
            this.typing.delete(id)
            revealed.push(job.sessionId)
          }
          if (this.screen === 'chat' && this.session?.id === job.sessionId) visibleSession = job.sessionId
          else this.emit()
        }
        if (visibleSession) {
          this.emit()
          await this.glasses.updateBodyNow(this.bodyText())
        }
        for (const sessionId of revealed) void this.openDueChart(sessionId)
        const elapsed = Date.now() - now
        if (elapsed < MIN_STEP_MS) await sleep(MIN_STEP_MS - elapsed)
        // Nothing left to reveal but the run is still streaming: idle until more text arrives.
        while (this.typing.size && !this.stopped && [...this.typing.values()].every(j => j.entry.text === j.target && !j.done)) {
          await sleep(100)
          last = Date.now() - MIN_STEP_MS
        }
      }
    } finally {
      this.typeLoopRunning = false
    }
    if (this.screen === 'chat') this.render()
  }

  /**
   * Double-tap while something is in flight: stop the run on the gateway and end the paced
   * reveal, keeping whatever text is already on screen. Returns false when there was nothing
   * to interrupt (the caller then treats the gesture as "back").
   */
  private interruptReply(): boolean {
    const sessionId = this.session?.id
    if (!sessionId) return false
    const feed = this.feed(sessionId)
    let did = false
    const tracker = this.runs.get(sessionId)
    if (tracker && !TERMINAL_STATUSES.has(tracker.status)) {
      tracker.interrupted = true
      did = true
      this.log(`interrupting run ${tracker.runId}`)
      this.client.stop(tracker.runId).catch(err => {
        feed.add('error', `stop failed: ${(err as Error).message}`)
        this.render(sessionId)
      })
    }
    for (const [id, job] of this.typing) {
      if (job.sessionId !== sessionId) continue
      this.typing.delete(id)
      if (job.entry.text !== job.target) feed.update(job.entry, { text: `${job.entry.text.trimEnd()} …` })
      did = true
    }
    if (did) {
      feed.add('system', 'interrupted')
      this.render(sessionId)
    }
    return did
  }

  /** Is an answer still being revealed for this session? (keeps the status bar animating) */
  private typingFor(sessionId: string): boolean {
    for (const job of this.typing.values()) if (job.sessionId === sessionId && job.entry.text !== job.target) return true
    return false
  }

  private async startListening(): Promise<void> {
    if (this.mode !== 'idle') return
    this.chunks = []
    this.chunkBytes = 0
    this.mode = 'listening'
    this.listenStart = Date.now()
    const source = this.settings.micSource === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses
    let ok = false
    try {
      ok = await this.deps.bridge.audioControl(true, source)
    } catch (err) {
      this.log(`audioControl failed: ${(err as Error).message}`)
    }
    if (!ok) {
      this.mode = 'idle'
      this.glasses.updateStatus('× Microphone unavailable · tap to retry')
      this.emit()
      return
    }
    this.log('listening')
    this.live = startLiveTranscription(this.settings, {
      onPartial: (final, interim) => this.showDraft(final, interim),
      onError: msg => {
        this.log(`live transcription: ${msg}`)
        this.render()
      },
    })
    this.listenTimer = window.setTimeout(() => void this.stopAndSend(), this.settings.maxListenSeconds * 1000)
    this.render()
  }

  private async cancelListening(): Promise<void> {
    if (this.mode !== 'listening') return
    this.clearListenTimers()
    this.mode = 'idle'
    this.chunks = []
    this.chunkBytes = 0
    this.live?.cancel()
    this.live = null
    this.dropDraft()
    try {
      await this.deps.bridge.audioControl(false)
    } catch {
      /* ignore */
    }
    this.log('listening cancelled')
    this.render()
  }

  private async stopAndSend(): Promise<void> {
    if (this.mode !== 'listening') return
    this.clearListenTimers()
    this.mode = 'transcribing'
    try {
      await this.deps.bridge.audioControl(false)
    } catch {
      /* ignore */
    }
    const pcm = concatChunks(this.chunks)
    this.chunks = []
    this.chunkBytes = 0
    const stats = pcmStats(pcm)
    this.lastAudio = { seconds: +stats.seconds.toFixed(2), rms: Math.round(stats.rms), peak: stats.peak }
    this.log(`audio: ${stats.seconds.toFixed(2)}s rms=${Math.round(stats.rms)} peak=${stats.peak}`)
    this.render()

    // 1. Live transcript (already on screen) — just flush it.
    let text = ''
    const live = this.live
    this.live = null
    if (live) {
      try {
        text = (await live.finish()).trim()
      } catch (err) {
        this.log(`live finish failed: ${(err as Error).message}`)
      }
      if (text) this.log(`heard (live): ${text}`)
    }

    // 2. Otherwise the batch path, guarded by the silence rule.
    if (!text) {
      if (stats.seconds < 0.3 || stats.rms < this.settings.minAudioRms) {
        this.mode = 'idle'
        this.dropDraft()
        this.glasses.updateStatus(`· No audio (${stats.seconds.toFixed(1)}s, rms ${Math.round(stats.rms)}) · tap: talk`)
        this.emit()
        return
      }
      try {
        text = (await transcribePcm(pcm, this.settings)).trim()
      } catch (err) {
        this.mode = 'idle'
        this.dropDraft()
        this.feed().add('error', `transcription failed: ${(err as Error).message}`)
        this.log(`stt failed: ${(err as Error).message}`)
        this.render()
        return
      }
      if (!text) {
        this.mode = 'idle'
        this.dropDraft()
        this.glasses.updateStatus('· Nothing heard · tap: talk')
        this.emit()
        return
      }
      this.log(`heard: ${text}`)
    }
    const entry = this.draft
    this.draft = null
    await this.submit(text, entry ?? undefined)
  }

  // ---- runs ------------------------------------------------------------------------------------

  /** Typed input from the companion UI (or a dev script): behaves exactly like a spoken message. */
  async submitText(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean) return
    if (this.screen === 'menu' || this.screen === 'error' || this.screen === 'boot') {
      if (!this.session) await this.newSession()
      else await this.enterChat(this.session, true)
    }
    if (this.screen === 'approval') return
    if (this.screen === 'chart') await this.closeChart()
    if (this.screen === 'hidden') await this.wake()
    if (this.mode === 'listening') await this.cancelListening()
    if (this.mode !== 'idle') return
    this.log(`typed: ${clean}`)
    await this.submit(clean)
  }

  private async submit(text: string, entry?: FeedEntry): Promise<void> {
    if (!this.session) return
    this.mode = 'sending'
    await this.saveSession(this.session)
    const sessionId = this.session.id
    const feed = this.feed(sessionId)
    if (entry) feed.update(entry, { text })
    else feed.add('user', text)
    feed.jumpToEnd()
    this.render(sessionId)

    const existing = this.runs.get(sessionId)
    if (existing && existing.status === 'running') {
      try {
        await this.client.steer(existing.runId, text)
        feed.add('system', 'steer delivered')
        this.mode = 'idle'
        this.render(sessionId)
        return
      } catch (err) {
        this.log(`steer rejected (${(err as Error).message}); sending as new run`)
      }
    }
    try {
      const { run_id } = await this.client.createRun(text, sessionId, await this.runInstructions())
      const tracker: RunTracker = {
        runId: run_id,
        sessionId,
        status: 'running',
        abort: new AbortController(),
        streaming: false,
        link: 'connecting',
        lastActivity: '',
        approvalIds: new Set(),
      }
      this.runs.set(sessionId, tracker)
      this.log(`run ${run_id} started`)
      this.mode = 'idle'
      this.render(sessionId)
      void this.follow(tracker)
    } catch (err) {
      this.mode = 'idle'
      feed.add('error', `send failed: ${(err as Error).message}`)
      this.log(`createRun failed: ${(err as Error).message}`)
      this.render(sessionId)
    }
  }

  /** Stream events; if the stream drops before a terminal event, fall back to status polling. */
  private async follow(tracker: RunTracker): Promise<void> {
    tracker.streaming = true
    tracker.link = 'connecting'
    this.emit()
    this.render(tracker.sessionId)
    try {
      await this.client.streamRunEvents(
        tracker.runId,
        ev => this.onRunEvent(tracker, ev),
        tracker.abort.signal,
        () => {
          tracker.link = 'streaming'
          this.render(tracker.sessionId)
        },
      )
    } catch (err) {
      this.log(`event stream failed for ${tracker.runId}: ${(err as Error).message}`)
      if (!TERMINAL_STATUSES.has(tracker.status)) {
        this.feed(tracker.sessionId).add('system', 'live stream lost — polling status')
        this.render(tracker.sessionId)
      }
    }
    tracker.streaming = false
    tracker.link = 'polling'
    this.emit()
    this.log(`stream ended for ${tracker.runId} (status ${tracker.status})`)
    if (tracker.abort.signal.aborted || TERMINAL_STATUSES.has(tracker.status)) return
    this.render(tracker.sessionId)
    await this.poll(tracker)
  }

  private async poll(tracker: RunTracker): Promise<void> {
    const deadline = Date.now() + POLL_MAX_MS
    while (!tracker.abort.signal.aborted && Date.now() < deadline) {
      await sleep(POLL_MS)
      let status: RunStatus
      try {
        status = await this.client.getRun(tracker.runId)
      } catch (err) {
        this.log(`poll failed: ${(err as Error).message}`)
        continue
      }
      tracker.status = status.status
      if (status.last_event && status.last_event !== tracker.lastActivity) {
        tracker.lastActivity = status.last_event
        this.render(tracker.sessionId)
      }
      if (status.status === 'waiting_for_approval' && status.approval) {
        const ev = status.approval
        const id = ev.request_id ?? `${tracker.runId}:${ev.pattern_key ?? ev.command ?? ''}`
        if (!tracker.approvalIds.has(id)) {
          tracker.approvalIds.add(id)
          void this.queueApproval(tracker, ev)
        }
      }
      if (TERMINAL_STATUSES.has(status.status)) {
        this.finishRun(tracker, status.status, status.output, status.error)
        return
      }
    }
  }

  private onRunEvent(tracker: RunTracker, ev: RunEvent): void {
    const feed = this.feed(tracker.sessionId)
    const verbose = this.settings.feedDetail === 'verbose'
    switch (ev.event) {
      case 'message.delta': {
        if (!tracker.assistant) {
          tracker.assistant = feed.add('assistant', '')
          tracker.streamed = ''
          this.anchorAnswer(feed, tracker.assistant)
        }
        tracker.streamed = (tracker.streamed ?? '') + (ev.delta ?? '')
        tracker.lastActivity = 'replying'
        this.setAnswerText(tracker.sessionId, tracker.assistant, this.answerText(tracker.sessionId, tracker.streamed, tracker), false)
        break
      }
      case 'message.interim': {
        if (!ev.already_streamed && ev.text) feed.add('interim', plainify(verbose ? ev.text : oneLine(ev.text, 200)))
        break
      }
      case 'tool.started': {
        tracker.assistant = undefined
        const summary = summarizeToolCall(ev.tool, ev.preview, verbose ? 110 : 64)
        tracker.lastActivity = summary
        feed.add('tool', summary, { tool: ev.tool })
        break
      }
      case 'tool.completed': {
        const open = feed.openTool(ev.tool)
        const dur = ev.duration !== undefined ? ` ${Number(ev.duration).toFixed(1)}s` : ''
        const failed = !!ev.error || (!verbose && looksLikeError(ev.preview) && !open)
        const base = open ? open.text : summarizeToolCall(ev.tool, null)
        // "tool: args" -> "tool 0.9s: args"; results stay hidden in compact mode unless it failed.
        const head = base.replace(/^([^\s:]+)(:?)/, `$1${dur}$2`)
        const result = verbose || ev.error ? summarizeToolResult(ev.preview, verbose ? 90 : 70) : ''
        const text = result ? `${head}\n→ ${result}` : head
        if (open) feed.update(open, { text, done: true, failed })
        else feed.add('tool', text, { tool: ev.tool, done: true, failed })
        tracker.lastActivity = `${ev.tool} done`
        break
      }
      case 'reasoning.available': {
        // Compact mode hides reasoning; some providers also echo the answer itself here.
        if (!verbose) break
        const text = oneLine(ev.text, 160)
        if (text && text !== oneLine(tracker.assistant?.text ?? '', 160)) feed.add('reasoning', text)
        break
      }
      case 'subagent.start': {
        tracker.assistant = undefined
        tracker.lastActivity = 'subagent'
        feed.add('subagent', `subagent: ${oneLine(ev.goal ?? ev.preview, verbose ? 120 : 70)}`)
        break
      }
      case 'subagent.complete': {
        feed.add('subagent', `subagent ${ev.status ?? 'done'}: ${oneLine(ev.summary ?? ev.preview, verbose ? 140 : 90)}`)
        break
      }
      case 'approval.request': {
        tracker.status = 'waiting_for_approval'
        const id = ev.request_id ?? `${tracker.runId}:${ev.pattern_key ?? ev.command ?? ''}`
        tracker.approvalIds.add(id)
        void this.queueApproval(tracker, ev)
        break
      }
      case 'approval.responded': {
        tracker.status = 'running'
        feed.add('system', `approval: ${ev.choice}`)
        this.pendingApprovals.delete(tracker.sessionId)
        if (this.approval?.tracker === tracker && this.screen === 'approval') void this.closeApproval()
        break
      }
      case 'run.steered': {
        feed.add('system', 'steer accepted')
        break
      }
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
      case 'run.interrupted': {
        const status = ev.event.slice('run.'.length) as RunStatus['status']
        this.finishRun(tracker, status, ev.output, ev.error)
        return
      }
      default: {
        const name = (ev as { event: string }).event
        if (!TERMINAL_EVENTS.has(name)) this.log(`event ${name}`)
      }
    }
    this.render(tracker.sessionId)
  }

  /** Show a fresh answer from its first line, unless the user has scrolled away on their own. */
  private anchorAnswer(feed: Feed, entry: FeedEntry): void {
    if (feed.follow || feed.anchored) feed.anchorTo(entry)
  }

  private finishRun(tracker: RunTracker, status: RunStatus['status'], output?: string, error?: string): void {
    tracker.status = status
    tracker.lastActivity = ''
    const feed = this.feed(tracker.sessionId)
    if (status === 'completed') {
      const text = this.answerText(tracker.sessionId, output ?? '', tracker, true)
      if (text) {
        if (!tracker.assistant) {
          tracker.assistant = feed.add('assistant', '')
          this.anchorAnswer(feed, tracker.assistant)
        }
        this.setAnswerText(tracker.sessionId, tracker.assistant, text, true)
      } else if (!tracker.assistant) {
        feed.add('system', 'run completed (no text)')
      }
    } else if (status === 'failed') {
      feed.add('error', `run failed: ${oneLine(error ?? 'unknown error', 200)}`)
    } else if (!tracker.interrupted) {
      feed.add('system', `run ${status}`)
    }
    // A run that ended without completing leaves no more text to come: let any reveal finish.
    if (status !== 'completed' && tracker.assistant) {
      const job = this.typing.get(tracker.assistant.id)
      if (job) job.done = true
    }
    this.pendingApprovals.delete(tracker.sessionId)
    const answer = tracker.assistant
    tracker.assistant = undefined
    this.log(`run ${tracker.runId} ${status}`)
    if (status === 'completed' && tracker.chart) {
      this.chartDue.set(tracker.sessionId, tracker.chart)
      // Typing mode opens it when the reveal ends (typeLoop); otherwise the text is already up.
      if (!answer || !this.typing.has(answer.id)) void this.openDueChart(tracker.sessionId)
    }
    tracker.chart = undefined
    if (this.approval?.tracker === tracker && this.screen === 'approval') void this.closeApproval()
    this.render(tracker.sessionId)
  }

  // ---- charts ------------------------------------------------------------------------------------

  /**
   * Answer text for the feed: g2chart blocks become a marker line (a still-streaming block is
   * hidden) and the chart is remembered for the session and, when given, the run.
   */
  private answerText(sessionId: string, raw: string, tracker?: RunTracker, final = false): string {
    const { text, charts, invalid } = extractCharts(raw)
    const chart = charts[0]
    if (chart) {
      this.lastChart.set(sessionId, chart)
      if (tracker) tracker.chart = chart
    }
    if (final && invalid) this.log(`ignored ${invalid} invalid chart block(s)`)
    return plainify(text)
  }

  /** Open a finished answer's chart if the user is still looking at that session and idle. */
  private async openDueChart(sessionId: string): Promise<void> {
    const spec = this.chartDue.get(sessionId)
    if (!spec) return
    this.chartDue.delete(sessionId)
    const here = this.screen === 'chat' && this.session?.id === sessionId
    if (!here || this.mode !== 'idle' || this.pendingApprovals.has(sessionId)) return // still in the menu
    await this.showChartScreen(spec)
  }

  private async showChartScreen(spec: ChartSpec): Promise<void> {
    this.screen = 'chart'
    this.emit()
    try {
      const { tiles, preview } = await renderChart(spec)
      if (this.screen !== 'chart') return
      const unit = spec.unit && spec.type !== 'gauge' ? ` (${spec.unit})` : ''
      await this.glasses.showChart({
        title: fitLine(spec.title + unit, INNER_W),
        caption: wrapText(spec.caption, INNER_W).slice(0, 2).join('\n'),
        status: 'any gesture: back',
        tiles,
        preview,
      })
    } catch (err) {
      this.log(`chart failed: ${(err as Error).message}`)
      if (this.screen !== 'chart') return
      this.feed().add('error', `chart failed: ${oneLine((err as Error).message, 80)}`)
      await this.closeChart()
    }
  }

  private async closeChart(): Promise<void> {
    if (this.screen !== 'chart') return
    if (this.session) await this.enterChat(this.session, false)
    else await this.showMenu()
  }

  // ---- approvals ---------------------------------------------------------------------------------

  private async queueApproval(tracker: RunTracker, event: ApprovalRequestEvent): Promise<void> {
    const feed = this.feed(tracker.sessionId)
    feed.add('approval', `approval: ${oneLine(event.description ?? event.command ?? 'action', 140)}`)
    const pending: PendingApproval = { tracker, event }
    this.pendingApprovals.set(tracker.sessionId, pending)
    this.log(`approval requested on ${tracker.runId}: ${oneLine(event.command, 80)}`)
    const inSession = this.screen === 'chat' && this.session?.id === tracker.sessionId
    // A blocked run needs the user: an approval brings a hidden display back.
    if (this.screen === 'hidden' && this.session?.id === tracker.sessionId) await this.wake()
    else if (inSession && this.mode === 'idle') await this.presentApproval(pending)
    else if (this.screen === 'menu') await this.showMenu() // refresh header + session markers
    else this.render(tracker.sessionId)
  }

  private choicesOf(event: ApprovalRequestEvent): ApprovalChoice[] {
    const c = Array.isArray(event.choices) && event.choices.length ? event.choices : ['once', 'deny']
    return c.filter((x): x is ApprovalChoice => x in CHOICE_LABEL)
  }

  private approvalTexts(view: ApprovalView): { body: string; choices: string } {
    const { event } = view
    const title = event.smart_denied ? 'APPROVAL (flagged as risky)' : 'APPROVAL'
    const desc = event.description ? plainify(event.description) : ''
    const cmd = event.command ? `$ ${plainify(event.command)}` : ''
    const bodyLines = wrapText([title, desc, cmd].filter(Boolean).join('\n'), INNER_W)
    const body =
      bodyLines.length > APPROVAL_BODY_LINES
        ? [...bodyLines.slice(0, APPROVAL_BODY_LINES - 1), bodyLines[APPROVAL_BODY_LINES - 1] + ' …'].join('\n')
        : bodyLines.join('\n')
    const choices = this.choicesOf(event)
      .map((c, i) => `${i === view.cursor ? '●' : '○'} ${CHOICE_LABEL[c]}`)
      .join('   ')
    return { body, choices: `${choices}\n↑↓ choose · tap: confirm · double: deny` }
  }

  private async presentApproval(pending: PendingApproval): Promise<void> {
    this.approval = { ...pending, cursor: 0 }
    this.screen = 'approval'
    this.syncSpinner()
    this.emit()
    await this.glasses.showApproval(this.approvalTexts(this.approval))
  }

  private async closeApproval(): Promise<void> {
    this.approval = null
    if (!this.session) return this.showMenu()
    this.screen = 'chat'
    this.emit()
    await this.glasses.showChat({ body: this.bodyText(), status: this.statusLine() })
  }

  private moveApprovalCursor(delta: number): void {
    if (!this.approval) return
    const n = this.choicesOf(this.approval.event).length
    this.approval.cursor = (this.approval.cursor + delta + n) % n
    const t = this.approvalTexts(this.approval)
    this.glasses.updateApproval(t.body, t.choices)
  }

  private async resolveApproval(choice: ApprovalChoice): Promise<void> {
    const view = this.approval
    if (!view) return
    const { tracker, event } = view
    this.log(`approval ${choice} for ${tracker.runId}`)
    this.glasses.updateApproval(this.approvalTexts(view).body, `◌ Sending "${CHOICE_LABEL[choice]}"…`)
    try {
      await this.client.approve(tracker.runId, choice, event.request_id)
      this.pendingApprovals.delete(tracker.sessionId)
      tracker.status = 'running'
    } catch (err) {
      const msg = (err as Error).message
      this.feed(tracker.sessionId).add('error', `approval failed: ${msg}`)
      this.log(`approval failed: ${msg}`)
      // A 409 means the request is no longer pending (answered elsewhere or the run ended).
      if (err instanceof HermesError && err.status === 409) this.pendingApprovals.delete(tracker.sessionId)
    }
    await this.closeApproval()
    // Make sure a dropped stream cannot leave the run untracked after the approval.
    if (!tracker.streaming && !TERMINAL_STATUSES.has(tracker.status) && !tracker.abort.signal.aborted) {
      void this.poll(tracker)
    }
  }

  // ---- gestures ---------------------------------------------------------------------------------

  async handleGesture(g: Gesture): Promise<void> {
    if (g.kind === 'exit') return this.stop()
    if (g.kind === 'fg_enter' || g.kind === 'fg_exit' || g.kind === 'long_release') return
    if (g.kind === 'menu') return this.handleMenuItem(g.menuItemId ?? 0)
    if (this.screen === 'hidden') return this.wake() // any gesture, including another long press
    if (g.kind === 'long') return this.hide()
    switch (this.screen) {
      case 'boot':
        return
      case 'error':
        if (g.kind === 'double') await this.glasses.exit(1)
        else if (g.kind === 'tap') await this.start()
        return
      case 'menu':
        return this.handleMenuGesture(g)
      case 'chat':
        return this.handleChatGesture(g)
      case 'approval':
        return this.handleApprovalGesture(g)
      case 'chart':
        // Any gesture leaves the chart (a tap must not start listening).
        return this.closeChart()
    }
  }

  // ---- hide (long press) ---------------------------------------------------------------------------

  /** Blank the glasses; runs, typing and approvals carry on in the background. */
  private async hide(): Promise<void> {
    // Not over a pending decision or while connecting: those need the display.
    if (this.screen === 'approval' || this.screen === 'boot') return
    if (this.mode === 'listening') await this.cancelListening()
    this.hiddenFrom = this.screen
    this.screen = 'hidden'
    this.syncSpinner()
    this.emit()
    await this.glasses.showBlank()
  }

  private async wake(): Promise<void> {
    if (this.screen !== 'hidden') return
    if (this.hiddenFrom === 'error') return this.start()
    if (this.hiddenFrom === 'menu' || !this.session) return this.showMenu()
    // enterChat redraws the latest state and presents a pending approval.
    return this.enterChat(this.session, false)
  }

  private async handleMenuItem(id: number): Promise<void> {
    switch (id) {
      case MENU_ITEMS.STOP_RUN: {
        const tracker = this.session ? this.runs.get(this.session.id) : undefined
        if (tracker && !TERMINAL_STATUSES.has(tracker.status)) {
          try {
            await this.client.stop(tracker.runId)
            this.feed(tracker.sessionId).add('system', 'stop requested')
          } catch (err) {
            this.feed(tracker.sessionId).add('error', `stop failed: ${(err as Error).message}`)
          }
          this.render(tracker.sessionId)
        }
        return
      }
      case MENU_ITEMS.NEW_SESSION:
        if (this.mode === 'listening') await this.cancelListening()
        return this.newSession()
      case MENU_ITEMS.SESSIONS:
        return this.goToMenu()
      case MENU_ITEMS.LAST_CHART: {
        const spec = this.session ? this.lastChart.get(this.session.id) : undefined
        if (spec && this.mode === 'idle') return this.showChartScreen(spec)
        if (!spec && this.session) {
          this.feed().add('system', 'no chart in this session yet')
          this.render()
        }
        return
      }
      case MENU_ITEMS.RECONNECT: {
        const tracker = this.session ? this.runs.get(this.session.id) : undefined
        if (tracker && !tracker.streaming && !TERMINAL_STATUSES.has(tracker.status)) {
          tracker.abort = new AbortController()
          void this.follow(tracker)
        } else if (this.screen === 'chat') {
          this.render()
        } else {
          await this.start()
        }
        return
      }
    }
  }

  private async handleMenuGesture(g: Gesture): Promise<void> {
    if (g.kind === 'double') {
      await this.glasses.exit(1)
      return
    }
    if (g.kind === 'tap') {
      const index = g.listIndex ?? 0
      if (index <= 0) return this.newSession()
      return this.openSession(index - 1)
    }
  }

  private async handleChatGesture(g: Gesture): Promise<void> {
    switch (g.kind) {
      case 'tap': {
        const pending = this.pendingApprovals.get(this.session?.id ?? '')
        if (pending && this.mode === 'idle') return this.presentApproval(pending)
        if (this.mode === 'idle') return this.startListening()
        if (this.mode === 'listening') return this.stopAndSend()
        return
      }
      case 'double': {
        if (this.mode === 'listening') return this.cancelListening()
        if (this.interruptReply()) return
        return this.goToMenu()
      }
      case 'up':
      case 'down': {
        if (this.smooth) {
          if (this.shiftWindow(g.kind) || g.kind === 'down') this.render()
          return
        }
        const feed = this.feed()
        const from = feed.lineOffset
        const moved = g.kind === 'up' ? feed.scrollUp() : feed.scrollDown()
        if (moved) this.turnPage(from, feed.lineOffset)
        else this.render()
        return
      }
    }
  }

  private async handleApprovalGesture(g: Gesture): Promise<void> {
    if (!this.approval) return this.closeApproval()
    switch (g.kind) {
      case 'up':
        return this.moveApprovalCursor(-1)
      case 'down':
        return this.moveApprovalCursor(1)
      case 'tap': {
        const choice = this.choicesOf(this.approval.event)[this.approval.cursor] ?? 'deny'
        return this.resolveApproval(choice)
      }
      case 'double':
        return this.resolveApproval('deny')
    }
  }

  get errorMessage(): string {
    return this.lastError
  }
}

function messageText(m: HermesMessage): string {
  const c = m.content
  if (!c) return ''
  if (typeof c === 'string') return c
  return c
    .filter(p => p && p.type === 'text' && p.text)
    .map(p => p.text as string)
    .join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
