// Text shaping for the 576x288 glasses canvas. The firmware wraps with a single proportional
// LVGL font; @evenrealities/pretext reproduces its glyph metrics so we can pre-wrap into lines
// that the glasses will not re-wrap, and page the result ourselves.

import { getTextWidth, pxTruncate } from '@evenrealities/pretext'

export const LINE_HEIGHT = 27
export const CANVAS_W = 576
export const CANVAS_H = 288

/** Greedy word wrap into lines whose measured width fits `maxWidth`. `\n` forces a break. */
export function wrapText(text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('')
      continue
    }
    let line = ''
    for (const token of para.split(/(\s+)/)) {
      if (!token) continue
      if (/^\s+$/.test(token)) {
        if (line) line += ' '
        continue
      }
      const candidate = line ? line + token : token
      if (getTextWidth(candidate) <= maxWidth) {
        line = candidate
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      if (getTextWidth(token) <= maxWidth) {
        line = token
      } else {
        // Single token wider than the line: hard-break by code point.
        let piece = ''
        for (const ch of token) {
          if (getTextWidth(piece + ch) <= maxWidth) {
            piece += ch
          } else {
            if (piece) out.push(piece)
            piece = ch
          }
        }
        line = piece
      }
    }
    if (line.trim()) out.push(line.trimEnd())
  }
  return out
}

/** Truncate to one line of at most `maxWidth` px, appending "..." when cut. */
export function fitLine(text: string, maxWidth: number): string {
  return pxTruncate(sanitize(text).replace(/\s+/g, ' ').trim(), maxWidth)
}

/** Drop control characters and normalise whitespace the firmware cannot draw. */
export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/ /g, ' ')
}

/**
 * Flatten Markdown into plain text that reads well on a monochrome 9-line display:
 * headings, emphasis, links, code fences, list bullets and tables are reduced to their text.
 */
export function plainify(markdown: string): string {
  let t = sanitize(markdown)
  t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n+$/, ''))
  t = t.replace(/`([^`\n]+)`/g, '$1')
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s{0,3}>\s?/gm, '')
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2')
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2')
  t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1$2')
  t = t.replace(/^\s*[-*+]\s+/gm, '• ')
  t = t.replace(/^\s*(\d+)[.)]\s+/gm, '$1. ')
  t = t.replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, '') // table separator rows
  t = t.replace(/^\s*\|(.*)\|\s*$/gm, (_m, row: string) => row.split('|').map(c => c.trim()).join('  '))
  t = t.replace(/^\s*([-*_]){3,}\s*$/gm, '─────')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

/** Compress a tool argument / result preview into a single short line. */
export function oneLine(text: string | null | undefined, max = 120): string {
  const s = sanitize(String(text ?? '')).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
