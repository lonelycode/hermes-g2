// Conversation feed model: a list of entries (user turns, assistant text, tool steps, system
// notes) rendered into wrapped lines and paged for the glasses. Lines are wrapped lazily so a
// burst of streaming deltas only costs one re-wrap per render.

import { wrapText } from '../glasses/text.ts'

export type EntryKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'interim'
  | 'reasoning'
  | 'subagent'
  | 'approval'
  | 'system'
  | 'error'

export interface FeedEntry {
  id: number
  kind: EntryKind
  text: string
  tool?: string
  done?: boolean
  failed?: boolean
  duration?: number
}

// Glyphs verified to exist in the firmware font tables (see scripts/check-glyphs.mjs).
// Turns are labelled; everything that happens *between* turns (tool steps, commentary, system
// notes) is indented under the user turn so the answer stands out as the next flush-left block.
export const PREFIX: Record<EntryKind, string> = {
  user: '▶ You: ',
  assistant: '■ Hermes: ',
  tool: '○ ',
  interim: '· ',
  reasoning: '· ',
  subagent: '» ',
  approval: '? ',
  system: '· ',
  error: '× ',
}
export const PREFIX_TOOL_DONE = '● '
export const PREFIX_TOOL_FAILED = '× '
// Tree connectors (all present in the firmware font): steps hang off the turn above them.
export const STEP_BRANCH = ' ├ '
export const STEP_LAST = ' └ '
export const STEP_CONT = ' │ '
export const STEP_CONT_LAST = '   '
const STEP_INDENT_PX = 40
const TURN_KINDS: ReadonlySet<EntryKind> = new Set(['user', 'assistant'])

export interface FeedPosition {
  page: number
  pages: number
  atEnd: boolean
  follow: boolean
}

export class Feed {
  readonly entries: FeedEntry[] = []
  private nextId = 1
  private cache = new Map<number, string[]>()
  private flat: string[] | null = null
  private offset = 0
  follow = true
  /** Entry pinned to the top of the page (the latest answer) until the user scrolls. */
  private anchor: FeedEntry | null = null
  private readonly width: number
  readonly pageLines: number

  constructor(width: number, pageLines: number) {
    this.width = width
    this.pageLines = pageLines
  }

  add(kind: EntryKind, text: string, extra: Partial<FeedEntry> = {}): FeedEntry {
    const entry: FeedEntry = { id: this.nextId++, kind, text, ...extra }
    this.entries.push(entry)
    this.flat = null
    return entry
  }

  update(entry: FeedEntry, patch: Partial<FeedEntry>): void {
    Object.assign(entry, patch)
    this.cache.delete(entry.id)
    this.flat = null
  }

  remove(entry: FeedEntry): void {
    const i = this.entries.indexOf(entry)
    if (i === -1) return
    this.entries.splice(i, 1)
    this.cache.delete(entry.id)
    this.flat = null
  }

  append(entry: FeedEntry, delta: string): void {
    this.update(entry, { text: entry.text + delta })
  }

  last(kind?: EntryKind): FeedEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (!kind || this.entries[i].kind === kind) return this.entries[i]
    }
    return undefined
  }

  /** Most recent tool entry with this name that has not completed yet. */
  openTool(name: string): FeedEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.kind === 'tool' && !e.done && (!name || e.tool === name)) return e
    }
    return undefined
  }

  clear(): void {
    this.entries.length = 0
    this.cache.clear()
    this.flat = null
    this.offset = 0
    this.follow = true
    this.anchor = null
  }

  /** Pin `entry`'s first line to the top of the page (used for a fresh answer). */
  anchorTo(entry: FeedEntry): void {
    this.anchor = entry
    this.follow = false
    this.flat = null
  }

  get anchored(): boolean {
    return this.anchor !== null
  }

  /** Wrapped body lines without any tree decoration (cached per entry). */
  private bodyLines(entry: FeedEntry): string[] {
    let lines = this.cache.get(entry.id)
    if (!lines) {
      const prefix = entry.kind === 'tool' ? (entry.done ? (entry.failed ? PREFIX_TOOL_FAILED : PREFIX_TOOL_DONE) : PREFIX.tool) : PREFIX[entry.kind]
      const body = entry.text.trim() ? entry.text : entry.kind === 'assistant' ? '…' : ''
      lines = TURN_KINDS.has(entry.kind) ? wrapText(prefix + body, this.width) : wrapText(prefix + body, this.width - STEP_INDENT_PX)
      if (!lines.length) lines = [prefix.trim()]
      this.cache.set(entry.id, lines)
    }
    return lines
  }

  private linesFor(entry: FeedEntry, first: boolean, lastStep: boolean): string[] {
    const body = this.bodyLines(entry)
    if (TURN_KINDS.has(entry.kind)) {
      // A blank separator ahead of each turn keeps turns visually distinct.
      return first ? body : ['', ...body]
    }
    // Steps hang off the turn above: ├ for intermediate steps, └ for the last one in the group.
    return body.map((l, i) => (i === 0 ? (lastStep ? STEP_LAST : STEP_BRANCH) : lastStep ? STEP_CONT_LAST : STEP_CONT) + l)
  }

  lines(): string[] {
    if (this.flat) return this.flat
    const out: string[] = []
    let anchorIndex = -1
    this.entries.forEach((e, i) => {
      const next = this.entries[i + 1]
      const lastStep = !next || TURN_KINDS.has(next.kind)
      if (e === this.anchor) anchorIndex = out.length + (i === 0 ? 0 : 1) // skip the separator line
      out.push(...this.linesFor(e, i === 0, lastStep))
    })
    this.flat = out
    if (this.anchor && anchorIndex >= 0) this.offset = anchorIndex
    else if (this.follow) this.offset = this.maxOffset()
    else this.offset = Math.min(this.offset, this.maxOffset())
    return out
  }

  private maxOffset(): number {
    return Math.max(0, (this.flat ?? this.lines()).length - this.pageLines)
  }

  /** Text for the current page. */
  page(): string {
    const lines = this.lines()
    if (!lines.length) return ''
    return lines.slice(this.offset, this.offset + this.pageLines).join('\n')
  }

  position(): FeedPosition {
    const total = this.lines().length
    const pages = Math.max(1, Math.ceil(total / this.pageLines))
    const page = this.offset >= this.maxOffset() ? pages : Math.min(pages, Math.ceil((this.offset + this.pageLines) / this.pageLines))
    return { page, pages, atEnd: this.offset >= this.maxOffset(), follow: this.follow }
  }

  scrollUp(): boolean {
    this.lines()
    this.anchor = null
    if (this.offset === 0) return false
    this.offset = Math.max(0, this.offset - Math.max(1, this.pageLines - 1))
    this.follow = false
    return true
  }

  scrollDown(): boolean {
    this.lines()
    this.anchor = null
    const max = this.maxOffset()
    if (this.offset >= max) {
      this.offset = max
      this.follow = true
      return false
    }
    this.offset = Math.min(max, this.offset + Math.max(1, this.pageLines - 1))
    if (this.offset >= max) this.follow = true
    return true
  }

  jumpToEnd(): void {
    this.anchor = null
    this.follow = true
    this.flat = null
    this.lines()
  }
}
