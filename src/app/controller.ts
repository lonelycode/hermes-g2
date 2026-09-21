// The app state machine: menu (session list) ⇄ chat (feed + voice) ⇄ approval overlay.
// Owns the Hermes client, per-session feeds, run trackers, microphone capture and the mapping
// from ring/temple gestures to actions.

import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
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
import { fitLine, oneLine, plainify, wrapText } from '../glasses/text.ts'
import { Feed, type FeedEntry } from './feed.ts'
import { looksLikeError, summarizeToolCall, summarizeToolResult } from './summaries.ts'
import { cleanUserRow } from './history.ts'

export type Screen = 'boot' | 'error' | 'menu' | 'chat' | 'approval'
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
const POLL_MS = 2000
const POLL_MAX_MS = 6 * 60 * 60 * 1000

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
  private listenStart = 0
  private listenTimer: number | null = null
  private tickTimer: number | null = null
  private spinTimer: number | null = null
  private spinFrame = 0
  private lastAudio: ControllerSnapshot['lastAudio'] = null
  private stopped = false
  private lastError = ''

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
    await this.showMenu()
  }

  async applySettings(settings: Settings): Promise<void> {
    this.settings = settings
    this.client = this.makeClient()
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
    let session: HermesSession
    try {
      session = await this.client.createSession(title)
    } catch (err) {
      // Older gateways may lack POST /api/sessions; /v1/runs auto-creates the session anyway.
      this.log(`createSession failed, using client id: ${(err as Error).message}`)
      session = { id: `g2_${Date.now().toString(36)}`, title }
    }
    this.sessions.unshift(session)
    await this.enterChat(session, true)
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
        this.loadHistory(feed, messages)
      } catch (err) {
        feed.add('error', `history unavailable: ${(err as Error).message}`)
      }
      feed.jumpToEnd()
    }
    if (fresh && !feed.entries.length) {
      feed.add('system', `${session.title ?? 'New session'} — tap to talk`)
    }
    await this.glasses.showChat({ body: feed.page(), status: this.statusLine() })
    const pending = this.pendingApprovals.get(session.id)
    if (pending) await this.presentApproval(pending)
  }

  private loadHistory(feed: Feed, messages: HermesMessage[]): void {
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
        if (content) feed.add('assistant', plainify(content))
      }
    }
  }

  /** Is anything in flight for the visible session (drives the status-bar animation)? */
  private busy(): boolean {
    if (this.mode === 'transcribing' || this.mode === 'sending' || this.mode === 'listening') return true
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
        if (this.screen === 'chat') this.glasses.updateStatus(this.statusLine())
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
    const where = pos.pages > 1 ? `${pos.page}/${pos.pages}${pos.atEnd ? '' : '↓'} ` : ''
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
      return `${spin} ${state} · ${where}tap: steer`
    }
    return `${where}tap: talk · ↑↓ scroll · double: menu`
  }

  private render(sessionId?: string): void {
    if (this.screen !== 'chat' || !this.session) return
    if (sessionId && sessionId !== this.session.id) return
    this.glasses.updateBody(this.feed().page())
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
    if (this.mode === 'listening') await this.cancelListening()
    if (this.mode !== 'idle') return
    this.log(`typed: ${clean}`)
    await this.submit(clean)
  }

  private async submit(text: string, entry?: FeedEntry): Promise<void> {
    if (!this.session) return
    this.mode = 'sending'
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
      const { run_id } = await this.client.createRun(text, sessionId)
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
        if (!tracker.assistant) tracker.assistant = feed.add('assistant', '')
        feed.append(tracker.assistant, ev.delta ?? '')
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

  private finishRun(tracker: RunTracker, status: RunStatus['status'], output?: string, error?: string): void {
    tracker.status = status
    tracker.lastActivity = ''
    const feed = this.feed(tracker.sessionId)
    if (status === 'completed') {
      const text = plainify(output ?? '')
      if (text) {
        if (tracker.assistant) feed.update(tracker.assistant, { text })
        else feed.add('assistant', text)
      } else if (!tracker.assistant) {
        feed.add('system', 'run completed (no text)')
      }
    } else if (status === 'failed') {
      feed.add('error', `run failed: ${oneLine(error ?? 'unknown error', 200)}`)
    } else {
      feed.add('system', `run ${status}`)
    }
    this.pendingApprovals.delete(tracker.sessionId)
    tracker.assistant = undefined
    this.log(`run ${tracker.runId} ${status}`)
    if (this.approval?.tracker === tracker && this.screen === 'approval') void this.closeApproval()
    this.render(tracker.sessionId)
  }

  // ---- approvals ---------------------------------------------------------------------------------

  private async queueApproval(tracker: RunTracker, event: ApprovalRequestEvent): Promise<void> {
    const feed = this.feed(tracker.sessionId)
    feed.add('approval', `approval: ${oneLine(event.description ?? event.command ?? 'action', 140)}`)
    const pending: PendingApproval = { tracker, event }
    this.pendingApprovals.set(tracker.sessionId, pending)
    this.log(`approval requested on ${tracker.runId}: ${oneLine(event.command, 80)}`)
    const inSession = this.screen === 'chat' && this.session?.id === tracker.sessionId
    if (inSession && this.mode === 'idle') await this.presentApproval(pending)
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
    await this.glasses.showChat({ body: this.feed().page(), status: this.statusLine() })
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
    if (g.kind === 'fg_enter' || g.kind === 'fg_exit' || g.kind === 'long' || g.kind === 'long_release') return
    if (g.kind === 'menu') return this.handleMenuItem(g.menuItemId ?? 0)
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
    }
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
        return this.goToMenu()
      }
      case 'up': {
        if (this.feed().scrollUp()) this.render()
        return
      }
      case 'down': {
        this.feed().scrollDown()
        this.render()
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
