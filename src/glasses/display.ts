// Page layouts for the glasses and a small write queue in front of the bridge. Layout switches
// use rebuildPageContainer; in-place text changes use textContainerUpgrade (flicker-free).

import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type MenuContainerProperty,
} from '@evenrealities/even_hub_sdk'
import { CANVAS_H, CANVAS_W, LINE_HEIGHT } from './text.ts'

export const PAD = 4
export const BODY_H = 252
export const STATUS_Y = 254
export const STATUS_H = CANVAS_H - STATUS_Y
export const BODY_LINES = Math.floor((BODY_H - 2 * PAD) / LINE_HEIGHT) // 9
// Pretext metrics are close to firmware but not identical; wrap a little narrower than the
// container so the glasses never re-wrap a line (which would push content off the page).
export const WRAP_MARGIN = 24
export const INNER_W = CANVAS_W - 2 * PAD - WRAP_MARGIN // 544
export const APPROVAL_BODY_H = 198
export const APPROVAL_BODY_LINES = Math.floor((APPROVAL_BODY_H - 2 * PAD) / LINE_HEIGHT) // 7
export const LIST_HEADER_H = 30
export const MAX_LIST_ITEMS = 20
export const MAX_LIST_ITEM_CHARS = 64

export type LayoutName = 'message' | 'chat' | 'list' | 'approval'

const IDS = {
  message: { id: 1, name: 'msg' },
  body: { id: 2, name: 'body' },
  status: { id: 3, name: 'status' },
  header: { id: 4, name: 'header' },
  list: { id: 5, name: 'sessions' },
  apBody: { id: 6, name: 'apbody' },
  apChoice: { id: 7, name: 'apchoice' },
} as const

export const MENU_ITEMS = {
  STOP_RUN: 1,
  NEW_SESSION: 2,
  SESSIONS: 3,
  RECONNECT: 4,
} as const

export const MENU_OBJECT: MenuContainerProperty = {
  menuItems: [
    { itemName: 'Stop run', itemID: MENU_ITEMS.STOP_RUN },
    { itemName: 'New session', itemID: MENU_ITEMS.NEW_SESSION },
    { itemName: 'Sessions', itemID: MENU_ITEMS.SESSIONS },
    { itemName: 'Reconnect', itemID: MENU_ITEMS.RECONNECT },
  ],
} as MenuContainerProperty

function text(
  spec: { id: number; name: string },
  x: number,
  y: number,
  w: number,
  h: number,
  content: string,
  capture: boolean,
  extra: Partial<TextContainerProperty> = {},
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: x,
    yPosition: y,
    width: w,
    height: h,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: PAD,
    containerID: spec.id,
    containerName: spec.name,
    content: clampCreate(content),
    isEventCapture: capture ? 1 : 0,
    ...extra,
  })
}

const CREATE_MAX = 1000
const UPGRADE_MAX = 2000
function clampCreate(s: string): string {
  return s.length > CREATE_MAX ? s.slice(0, CREATE_MAX - 1) + '…' : s
}
function clampUpgrade(s: string): string {
  return s.length > UPGRADE_MAX ? s.slice(0, UPGRADE_MAX - 1) + '…' : s
}

export interface ChatPage {
  body: string
  status: string
}
export interface ListPage {
  header: string
  items: string[]
}
export interface ApprovalPage {
  body: string
  choices: string
}

export interface GlassesEvents {
  onMirror?(layout: LayoutName, containers: Record<string, string>): void
  /** Bridge write timing, for diagnosing a saturated BLE link. */
  onWriteStats?(stats: WriteStats): void
}

export interface WriteStats {
  /** Milliseconds the last textContainerUpgrade took to be accepted by the host. */
  lastMs: number
  /** Rolling average over the last 20 writes. */
  avgMs: number
  /** Writes currently waiting in the app-side queue. */
  queued: number
  /** Bytes sent in the last 5 seconds. */
  bytesPer5s: number
}

export class Glasses {
  private created = false
  private layout: LayoutName | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private lastContent = new Map<number, string>()
  private pending = new Map<number, string>()
  /** Latest content wanted per container; a queued write re-reads this so a backlog of stale
   *  pages (fast swiping) collapses into the newest one instead of replaying every step. */
  private desired = new Map<number, string>()
  private flushTimer: number | null = null
  private mirror: Record<string, string> = {}

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly events: GlassesEvents = {},
  ) {}

  get currentLayout(): LayoutName | null {
    return this.layout
  }

  private queued = 0
  private recent: number[] = []
  private sent: Array<{ at: number; bytes: number }> = []

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++
    const run = this.queue.then(fn, fn).finally(() => this.queued--)
    this.queue = run.catch(err => console.error(`[glasses] bridge call failed: ${(err as Error)?.message ?? err}`))
    return run
  }

  /** textContainerUpgrade wrapped with timing/byte accounting. */
  private async upgrade(id: number, name: string, content: string, textColor?: number): Promise<boolean> {
    const t0 = Date.now()
    const ok = await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: id, containerName: name, content, ...(textColor !== undefined ? { textColor } : {}) }),
    )
    const ms = Date.now() - t0
    this.recent.push(ms)
    if (this.recent.length > 20) this.recent.shift()
    const now = Date.now()
    this.sent.push({ at: now, bytes: content.length })
    this.sent = this.sent.filter(x => now - x.at < 5000)
    if (ms > 400) console.warn(`[glasses] slow write: ${ms}ms for ${content.length} chars (queue ${this.queued})`)
    this.events.onWriteStats?.({
      lastMs: ms,
      avgMs: Math.round(this.recent.reduce((a, b) => a + b, 0) / this.recent.length),
      queued: this.queued,
      bytesPer5s: this.sent.reduce((a, x) => a + x.bytes, 0),
    })
    return ok
  }

  private async buildPage(
    layout: LayoutName,
    containers: { textObject?: TextContainerProperty[]; listObject?: ListContainerProperty[] },
    menu: MenuContainerProperty | undefined,
  ): Promise<void> {
    const total = (containers.textObject?.length ?? 0) + (containers.listObject?.length ?? 0)
    const page = { containerTotalNum: total, ...containers, ...(menu ? { menuObject: menu } : {}) }
    this.pending.clear()
    this.lastContent.clear()
    this.desired.clear()
    for (const t of containers.textObject ?? []) this.lastContent.set(t.containerID!, t.content ?? '')
    if (!this.created) {
      const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
      if (result === StartUpPageCreateResult.success) {
        this.created = true
      } else {
        // The host already has a page for this app (page reload during development, or the
        // WebView was re-created while the glasses kept the old page): rebuild instead.
        console.warn(`[glasses] createStartUpPageContainer returned ${result}; falling back to rebuild`)
        const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(page))
        if (!ok) throw new Error(`createStartUpPageContainer failed (${result}) and rebuild failed`)
        this.created = true
      }
    } else {
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(page))
      if (!ok) throw new Error('rebuildPageContainer failed')
    }
    this.layout = layout
  }

  private setMirror(layout: LayoutName, containers: Record<string, string>): void {
    this.mirror = { ...containers }
    this.events.onMirror?.(layout, this.mirror)
  }

  /** Full-screen text page for startup / errors. Tap-capable. */
  showMessage(content: string, menu?: MenuContainerProperty): Promise<void> {
    return this.enqueue(async () => {
      await this.buildPage(
        'message',
        { textObject: [text(IDS.message, 0, 0, CANVAS_W, CANVAS_H, content, true)] },
        menu,
      )
      this.setMirror('message', { message: content })
    })
  }

  showChat(page: ChatPage, menu: MenuContainerProperty = MENU_OBJECT): Promise<void> {
    return this.enqueue(async () => {
      await this.buildPage(
        'chat',
        {
          textObject: [
            text(IDS.body, 0, 0, CANVAS_W, BODY_H, page.body || ' ', true),
            text(IDS.status, 0, STATUS_Y, CANVAS_W, STATUS_H, page.status, false, { textColor: 3 }),
          ],
        },
        menu,
      )
      this.setMirror('chat', { body: page.body, status: page.status })
    })
  }

  showList(page: ListPage, menu?: MenuContainerProperty): Promise<void> {
    const items = page.items.slice(0, MAX_LIST_ITEMS).map(s => s.slice(0, MAX_LIST_ITEM_CHARS))
    return this.enqueue(async () => {
      await this.buildPage(
        'list',
        {
          textObject: [text(IDS.header, 0, 0, CANVAS_W, LIST_HEADER_H, page.header, false, { textColor: 3 })],
          listObject: [
            new ListContainerProperty({
              xPosition: 0,
              yPosition: LIST_HEADER_H + 2,
              width: CANVAS_W,
              height: CANVAS_H - LIST_HEADER_H - 2,
              borderWidth: 0,
              borderColor: 5,
              paddingLength: PAD,
              containerID: IDS.list.id,
              containerName: IDS.list.name,
              isEventCapture: 1,
              itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemName: items }),
            }),
          ],
        },
        menu,
      )
      this.setMirror('list', { header: page.header, list: items.map((s, i) => `${i + 1}. ${s}`).join('\n') })
    })
  }

  showApproval(page: ApprovalPage, menu: MenuContainerProperty = MENU_OBJECT): Promise<void> {
    return this.enqueue(async () => {
      await this.buildPage(
        'approval',
        {
          textObject: [
            text(IDS.apBody, 0, 0, CANVAS_W, APPROVAL_BODY_H, page.body, true, { borderWidth: 1, borderColor: 8 }),
            text(IDS.apChoice, 0, APPROVAL_BODY_H + 2, CANVAS_W, CANVAS_H - APPROVAL_BODY_H - 2, page.choices, false),
          ],
        },
        menu,
      )
      this.setMirror('approval', { body: page.body, choices: page.choices })
    })
  }

  // ---- in-place updates (coalesced, ~120ms) ---------------------------------------------------

  private schedule(spec: { id: number; name: string }, content: string, mirrorKey: string): void {
    const text = clampUpgrade(content)
    this.pending.set(spec.id, text)
    this.desired.set(spec.id, text)
    if (spec.id === IDS.body.id) this.animSeq++ // a plain body write cancels a running transition
    this.mirror[mirrorKey] = content
    if (this.flushTimer !== null) return
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null
      const batch = [...this.pending.keys()]
      this.pending.clear()
      const layout = this.layout
      if (layout) this.events.onMirror?.(layout, this.mirror)
      for (const id of batch) {
        const name = Object.values(IDS).find(s => s.id === id)?.name ?? ''
        void this.enqueue(async () => {
          // Resolve the content at send time: only the newest wanted page goes over BLE.
          const latest = this.desired.get(id)
          if (latest === undefined || this.lastContent.get(id) === latest) return true
          this.lastContent.set(id, latest)
          return this.upgrade(id, name, latest)
        })
      }
    }, 120)
  }

  updateBody(content: string): void {
    if (this.layout === 'chat') this.schedule(IDS.body, content || ' ', 'body')
  }

  /** Write the body immediately (no coalescing delay) and resolve once the bridge accepted it. */
  updateBodyNow(content: string): Promise<void> {
    if (this.layout !== 'chat') return Promise.resolve()
    const text = clampUpgrade(content || ' ')
    this.pending.delete(IDS.body.id)
    this.desired.set(IDS.body.id, text)
    this.animSeq++
    this.mirror.body = content
    this.events.onMirror?.('chat', this.mirror)
    if (this.lastContent.get(IDS.body.id) === text) return this.flush()
    this.lastContent.set(IDS.body.id, text)
    return this.enqueue(() => this.upgrade(IDS.body.id, IDS.body.name, text)).then(() => undefined)
  }

  private animSeq = 0

  /**
   * Write a short sequence of body frames in order (a page-turn transition). A newer animation
   * or a plain updateBody supersedes the remaining frames. The last frame becomes the settled
   * content, so later coalesced writes compare against it.
   */
  animateBody(frames: Array<{ content: string; textColor?: number }>, gapMs: number): void {
    if (this.layout !== 'chat' || !frames.length) return
    const seq = ++this.animSeq
    const last = frames[frames.length - 1]
    const final = clampUpgrade(last.content || ' ')
    this.pending.delete(IDS.body.id)
    this.desired.set(IDS.body.id, final)
    this.mirror.body = last.content
    const layout = this.layout
    this.events.onMirror?.(layout, this.mirror)
    void this.enqueue(async () => {
      for (let i = 0; i < frames.length; i++) {
        // Superseded by a newer animation or by a plain write: stop (its own frames follow).
        if (seq !== this.animSeq || this.desired.get(IDS.body.id) !== final) return true
        const f = frames[i]
        const content = clampUpgrade(f.content || ' ')
        this.lastContent.set(IDS.body.id, content)
        await this.upgrade(IDS.body.id, IDS.body.name, content, f.textColor)
        if (i < frames.length - 1 && gapMs > 0) await new Promise(r => setTimeout(r, gapMs))
      }
      return true
    })
  }
  updateStatus(content: string): void {
    if (this.layout === 'chat') this.schedule(IDS.status, content, 'status')
  }
  updateMessage(content: string): void {
    if (this.layout === 'message') this.schedule(IDS.message, content, 'message')
  }
  updateApproval(body: string, choices: string): void {
    if (this.layout !== 'approval') return
    this.schedule(IDS.apBody, body, 'body')
    this.schedule(IDS.apChoice, choices, 'choices')
  }

  /** Wait until every queued bridge write has been sent. */
  flush(): Promise<void> {
    return this.enqueue(async () => undefined)
  }

  /** Mode 1 = system exit confirmation dialog (required from the root page). */
  exit(mode: 0 | 1 = 1): Promise<boolean> {
    return this.enqueue(() => this.bridge.shutDownPageContainer(mode))
  }
}
