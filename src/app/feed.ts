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
export const STEP_INDENT = '   '
const STEP_INDENT_PX = 18
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
  }

  private linesFor(entry: FeedEntry, first: boolean): string[] {
    let lines = this.cache.get(entry.id)
    if (!lines) {
      const prefix = entry.kind === 'tool' ? (entry.done ? (entry.failed ? PREFIX_TOOL_FAILED : PREFIX_TOOL_DONE) : PREFIX.tool) : PREFIX[entry.kind]
      const body = entry.text.trim() ? entry.text : entry.kind === 'assistant' ? '…' : ''
      if (TURN_KINDS.has(entry.kind)) {
        lines = wrapText(prefix + body, this.width)
      } else {
        // Hanging indent: every line of a step sits under the turn it belongs to.
        lines = wrapText(prefix + body, this.width - STEP_INDENT_PX).map(l => STEP_INDENT + l)
      }
      if (!lines.length) lines = [prefix.trim()]
      this.cache.set(entry.id, lines)
    }
    // A blank separator ahead of each user turn keeps turns visually distinct.
    return entry.kind === 'user' && !first ? ['', ...lines] : lines
  }

  lines(): string[] {
    if (this.flat) return this.flat
    const out: string[] = []
    this.entries.forEach((e, i) => out.push(...this.linesFor(e, i === 0)))
    this.flat = out
    if (this.follow) this.offset = this.maxOffset()
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
    if (this.offset === 0) return false
    this.offset = Math.max(0, this.offset - Math.max(1, this.pageLines - 1))
    this.follow = false
    return true
  }

  scrollDown(): boolean {
    this.lines()
    const max = this.maxOffset()
    if (this.offset >= max) {
      this.follow = true
      return false
    }
    this.offset = Math.min(max, this.offset + Math.max(1, this.pageLines - 1))
    if (this.offset >= max) this.follow = true
    return true
  }

  jumpToEnd(): void {
    this.follow = true
    this.flat = null
    this.lines()
  }
}
