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
  /** Lines moved per swipe; defaults to a page with one line of overlap. */
  step = 0
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

  releaseAnchor(): void {
    this.anchor = null
  }

  /** Line index where the anchored entry starts, or null. */
  anchorLine(): number | null {
    if (!this.anchor) return null
    let idx = 0
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      const next = this.entries[i + 1]
      const n = this.linesFor(e, i === 0, !next || TURN_KINDS.has(next.kind)).length
      if (e === this.anchor) return idx + (i === 0 ? 0 : 1)
      idx += n
    }
    return null
  }

  /**
   * A run of consecutive lines starting at `start`, capped by a line count and a character
   * budget (the glasses accept at most 2000 chars per text update). Used by smooth-scroll mode.
   */
  viewport(start: number, maxLines: number, maxChars: number): { text: string; start: number; end: number } {
    const lines = this.lines()
    const from = Math.max(0, Math.min(start, Math.max(0, lines.length - 1)))
    const out: string[] = []
    let chars = 0
    let i = from
    for (; i < lines.length && out.length < maxLines; i++) {
      const cost = lines[i].length + 1
      if (out.length && chars + cost > maxChars) break
      out.push(lines[i])
      chars += cost
    }
    return { text: out.join('\n'), start: from, end: i }
  }

  /** Wrapped body lines without any tree decoration (cached per entry). */
  private bodyLines(entry: FeedEntry): string[] {
    let lines = this.cache.get(entry.id)
    if (!lines) {
      const prefix = entry.kind === 'tool' ? (entry.done ? (entry.failed ? PREFIX_TOOL_FAILED : PREFIX_TOOL_DONE) : PREFIX.tool) : PREFIX[entry.kind]
      const body = entry.text.trim() ? entry.text.replace(/^\s+/, '') : entry.kind === 'assistant' ? '…' : ''
      if (entry.kind === 'assistant') {
        // The answer label gets its own line; the text below runs full width, identical while
        // streaming and once complete.
        lines = [PREFIX.assistant.trim(), ...wrapText(body, this.width)]
      } else {
        lines = TURN_KINDS.has(entry.kind) ? wrapText(prefix + body, this.width) : wrapText(prefix + body, this.width - STEP_INDENT_PX)
      }
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
    // Anchored: the answer starts at the top of the page until it overflows, then the page
    // follows its last line (so a paced reveal scrolls line by line).
    if (this.anchor && anchorIndex >= 0) this.offset = Math.max(anchorIndex, this.maxOffset())
    else if (this.follow) this.offset = this.maxOffset()
    else this.offset = Math.min(this.offset, this.maxOffset())
    return out
  }

  private maxOffset(): number {
    return Math.max(0, (this.flat ?? this.lines()).length - this.pageLines)
  }

  /** Current line offset of the page (page mode). */
  get lineOffset(): number {
    this.lines()
    return this.offset
  }

  /** Page text starting at an arbitrary line offset (used for transition frames). */
  pageAt(offset: number): string {
    const lines = this.lines()
    const from = Math.max(0, Math.min(offset, Math.max(0, lines.length - 1)))
    return lines.slice(from, from + this.pageLines).join('\n')
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
    this.offset = Math.max(0, this.offset - this.stepLines())
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
    this.offset = Math.min(max, this.offset + this.stepLines())
    if (this.offset >= max) this.follow = true
    return true
  }

  private stepLines(): number {
    return Math.max(1, this.step || this.pageLines - 1)
  }

  jumpToEnd(): void {
    this.anchor = null
    this.follow = true
    this.flat = null
    this.lines()
  }
}
