// Minimal Server-Sent Events frame parser for fetch() streams. EventSource cannot send an
// Authorization header, so the run event stream is read through fetch + ReadableStream.

export interface SseFrame {
  event?: string
  data: string
  id?: string
}

/** Incremental parser: feed() chunks of text, get complete frames back. */
export class SseParser {
  private buffer = ''

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const frames: SseFrame[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      const frame = parseFrame(raw)
      if (frame) frames.push(frame)
    }
    return frames
  }

  /** Flush a trailing frame without a terminating blank line (stream closed). */
  end(): SseFrame[] {
    const raw = this.buffer
    this.buffer = ''
    const frame = raw.trim() ? parseFrame(raw) : null
    return frame ? [frame] : []
  }
}

function parseFrame(raw: string): SseFrame | null {
  const dataLines: string[] = []
  let event: string | undefined
  let id: string | undefined
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue // comment / keepalive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
  }
  if (!dataLines.length) return null
  return { event, id, data: dataLines.join('\n') }
}
