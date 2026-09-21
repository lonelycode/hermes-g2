// Turns the raw previews Hermes attaches to tool events (usually JSON of the arguments, or the
// first 500 chars of a result) into one short human line for the glasses.

import { oneLine } from '../glasses/text.ts'

/** Argument keys worth showing, most informative first. */
const PREFERRED_KEYS = [
  'command', 'cmd', 'query', 'q', 'search', 'pattern', 'regex', 'path', 'file_path', 'filepath',
  'file', 'filename', 'directory', 'dir', 'url', 'urls', 'goal', 'task', 'prompt', 'question',
  'message', 'text', 'title', 'name', 'expression', 'code', 'input', 'content', 'body',
]

function parseJsonish(text: string): unknown {
  const t = text.trim()
  if (!t) return undefined
  const start = t.search(/[{[]/)
  if (start === -1) return undefined
  const candidates = [t.slice(start)]
  // Previews are often truncated JSON: try progressively closing it.
  candidates.push(t.slice(start) + '"}', t.slice(start) + '}', t.slice(start) + '"]}', t.slice(start) + ']}')
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      /* next */
    }
  }
  return undefined
}

function firstMeaningful(obj: Record<string, unknown>): { key: string; value: string } | undefined {
  for (const key of PREFERRED_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return { key, value: v }
    if (Array.isArray(v) && v.length && typeof v[0] === 'string') return { key, value: v.join(', ') }
  }
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) return { key, value: v }
    if (typeof v === 'number' || typeof v === 'boolean') return { key, value: String(v) }
  }
  return undefined
}

/**
 * One-line description of a tool call: `terminal: ls -la ~/projects`, `web_search: fibre plans`.
 * Falls back to the key names when no argument is a readable string.
 */
export function summarizeToolCall(tool: string, preview: string | null | undefined, max = 64): string {
  const raw = String(preview ?? '').trim()
  if (!raw) return tool
  const parsed = parseJsonish(raw)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const hit = firstMeaningful(obj)
    if (hit) return `${tool}: ${oneLine(hit.value, max)}`
    const keys = Object.keys(obj)
    return keys.length ? `${tool} (${keys.slice(0, 4).join(', ')})` : tool
  }
  if (Array.isArray(parsed)) return `${tool} (${parsed.length} items)`
  // Plain text preview: drop a leading "tool:" echo if present.
  const text = raw.replace(new RegExp(`^${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(]\\s*`, 'i'), '')
  return `${tool}: ${oneLine(text, max)}`
}

/**
 * Short result summary for verbose mode: JSON results collapse to their most useful field or a
 * size hint; text results keep their first line-ish.
 */
export function summarizeToolResult(preview: string | null | undefined, max = 80): string {
  const raw = String(preview ?? '').trim()
  if (!raw) return ''
  const parsed = parseJsonish(raw)
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed)) return `${parsed.length} results`
    const obj = parsed as Record<string, unknown>
    for (const key of ['error', 'message', 'summary', 'result', 'output', 'stdout', 'text', 'content', 'title']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim()) return oneLine(v, max)
    }
    const keys = Object.keys(obj)
    return keys.length ? `{${keys.slice(0, 4).join(', ')}}` : ''
  }
  return oneLine(raw, max)
}

/** Whether a completed-tool preview looks like an error worth surfacing even in compact mode. */
export function looksLikeError(preview: string | null | undefined): boolean {
  const raw = String(preview ?? '').slice(0, 200)
  return /\b(error|exception|traceback|denied|failed|not found|timed? ?out)\b/i.test(raw)
}
