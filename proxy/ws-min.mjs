// Minimal RFC 6455 WebSocket server helpers (handshake + framing) so the proxy stays free of
// dependencies. Enough for small binary/text frames, ping/pong and close; no extensions.

import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** Write the 101 handshake for an upgrade request. Returns false if it is not a WebSocket upgrade. */
export function handshake(req, socket, protocol) {
  const key = req.headers['sec-websocket-key']
  if (!key || !/websocket/i.test(String(req.headers.upgrade || ''))) return false
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ]
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`)
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  return true
}

export const OPCODE = { CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 }

/** Encode one unmasked server->client frame. */
export function encodeFrame(payload, opcode = OPCODE.TEXT, { mask = false } = {}) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload)
  const len = data.length
  let header
  if (len < 126) header = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  if (!mask) return Buffer.concat([header, data])
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78])
  header[1] |= 0x80
  const masked = Buffer.from(data)
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3]
  return Buffer.concat([header, key, masked])
}

/**
 * Incremental frame decoder. feed() returns complete frames as {opcode, payload, fin}.
 * Fragmented messages are reassembled into one frame with the initial opcode.
 */
export class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0)
    this.fragments = null
    this.fragmentOpcode = 0
  }
  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
    const frames = []
    for (;;) {
      const f = this.readOne()
      if (!f) break
      if (f.opcode === OPCODE.CONTINUATION) {
        if (this.fragments) this.fragments.push(f.payload)
        if (f.fin && this.fragments) {
          frames.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments), fin: true })
          this.fragments = null
        }
      } else if (!f.fin && (f.opcode === OPCODE.TEXT || f.opcode === OPCODE.BINARY)) {
        this.fragments = [f.payload]
        this.fragmentOpcode = f.opcode
      } else frames.push(f)
    }
    return frames
  }
  readOne() {
    const b = this.buffer
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < 4) return null
      len = b.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (b.length < 10) return null
      len = Number(b.readBigUInt64BE(2))
      off = 10
    }
    const maskKey = masked ? b.subarray(off, off + 4) : null
    if (masked) off += 4
    if (b.length < off + len) return null
    const payload = Buffer.from(b.subarray(off, off + len))
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
    this.buffer = b.subarray(off + len)
    return { fin, opcode, payload }
  }
}

/** Wrap a raw socket after the handshake into a tiny event-based connection. */
export function wrapSocket(socket, { onMessage, onClose, onError }) {
  const decoder = new FrameDecoder()
  let closed = false
  const send = (payload, opcode) => {
    if (closed || socket.destroyed) return
    socket.write(encodeFrame(payload, opcode ?? (typeof payload === 'string' ? OPCODE.TEXT : OPCODE.BINARY)))
  }
  const close = (code = 1000, reason = '') => {
    if (closed) return
    closed = true
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    try {
      socket.write(encodeFrame(body, OPCODE.CLOSE))
    } catch {
      /* ignore */
    }
    socket.end()
  }
  socket.on('data', chunk => {
    let frames
    try {
      frames = decoder.feed(chunk)
    } catch (err) {
      onError?.(err)
      return close(1002, 'bad frame')
    }
    for (const f of frames) {
      if (f.opcode === OPCODE.CLOSE) {
        close()
        onClose?.()
      } else if (f.opcode === OPCODE.PING) send(f.payload, OPCODE.PONG)
      else if (f.opcode === OPCODE.TEXT) onMessage?.(f.payload.toString('utf8'), false)
      else if (f.opcode === OPCODE.BINARY) onMessage?.(f.payload, true)
    }
  })
  socket.on('close', () => {
    if (!closed) {
      closed = true
      onClose?.()
    }
  })
  socket.on('error', err => onError?.(err))
  return { send, close, get closed() { return closed } }
}
