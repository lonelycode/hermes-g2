// Charts the agent can attach to a reply: a fenced ```g2chart block holding a small JSON spec.
// The block is cut out of the answer text (a marker line stays in its place) and drawn on the
// phone into image containers on the glasses (see ../glasses/chart.ts).

export type ChartType = 'bar' | 'line' | 'gauge'

export interface ChartSpec {
  type: ChartType
  title: string
  values: number[]
  labels: string[]
  unit: string
  caption: string
  min?: number
  max?: number
}

export const MAX_BARS = 12
export const MAX_POINTS = 60
const MAX_TITLE = 40
const MAX_LABEL = 8
const MAX_UNIT = 10
const MAX_CAPTION = 120

export const CHART_MARKER = '[chart]'
export const CHART_INVALID = '[chart unavailable]'

const FENCE = '```g2chart'
const BLOCK_RE = /(^|\n)[ \t]*```[ \t]*g2chart[^\n]*\n([\s\S]*?)\n?[ \t]*```[ \t]*(?=\n|$)/g
const OPEN_RE = /(^|\n)[ \t]*```[ \t]*g2chart/

/** Validate and normalise an agent-supplied spec; null when it cannot be drawn. */
export function parseChart(input: unknown): ChartSpec | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const type = o.type
  if (type !== 'bar' && type !== 'line' && type !== 'gauge') return null
  const title = str(o.title, MAX_TITLE)
  if (!title) return null
  const limit = type === 'bar' ? MAX_BARS : type === 'line' ? MAX_POINTS : 1
  const raw = Array.isArray(o.values) ? o.values : typeof o.value === 'number' ? [o.value] : []
  const values = raw.map(v => (typeof v === 'string' ? Number(v) : v)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!values.length) return null
  values.length = Math.min(values.length, limit)
  const labels = (Array.isArray(o.labels) ? o.labels : []).slice(0, values.length).map(l => str(l, MAX_LABEL))
  const spec: ChartSpec = { type, title, values, labels, unit: str(o.unit, MAX_UNIT), caption: str(o.caption, MAX_CAPTION) }
  const min = num(o.min)
  const max = num(o.max)
  if (type === 'gauge') {
    const v = values[0]
    spec.min = min ?? Math.min(0, v)
    spec.max = max ?? (v >= 0 && v <= 100 ? 100 : Math.max(v, spec.min + 1))
    if (spec.max <= spec.min) spec.max = spec.min + 1
  } else {
    if (min !== undefined) spec.min = min
    if (max !== undefined) spec.max = max
  }
  return spec
}

/**
 * Cut every complete g2chart block out of `raw` (leaving a marker line) and hide a block that
 * is still streaming, so its JSON never shows during the reveal. Runs before plainify, which
 * would otherwise unwrap the fence into plain text.
 */
export function extractCharts(raw: string): { text: string; charts: ChartSpec[]; invalid: number } {
  const charts: ChartSpec[] = []
  let invalid = 0
  let text = raw.replace(BLOCK_RE, (_m, lead: string, body: string) => {
    let spec: ChartSpec | null = null
    try {
      spec = parseChart(JSON.parse(body))
    } catch {
      /* invalid JSON */
    }
    if (!spec) {
      invalid++
      return `${lead}${CHART_INVALID}`
    }
    charts.push(spec)
    return `${lead}${CHART_MARKER} ${spec.title}`
  })
  const open = OPEN_RE.exec(text)
  if (open) text = text.slice(0, open.index)
  else {
    // A fence still arriving one token at a time: "`", "``", "```g2c"…
    const nl = text.lastIndexOf('\n')
    // A bare ``` that closes an ordinary code block (odd count of fences before it) stays.
    const tail = text.slice(nl + 1).replace(/[ \t]/g, '')
    const closes = tail === '```' && (text.slice(0, nl + 1).match(/^[ \t]*```/gm)?.length ?? 0) % 2 === 1
    if (tail.startsWith('`') && FENCE.startsWith(tail) && !closes) text = text.slice(0, nl + 1)
  }
  return { text, charts, invalid }
}

function str(v: unknown, max: number): string {
  if (typeof v !== 'string' && typeof v !== 'number') return ''
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
