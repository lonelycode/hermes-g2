import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameDecoder, encodeFrame, OPCODE, acceptKey } from '../proxy/ws-min.mjs'

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('masked client frames decode, including split delivery and 16-bit lengths', () => {
  const d = new FrameDecoder()
  const pcm = Buffer.alloc(3200, 7)
  const frame = encodeFrame(pcm, OPCODE.BINARY, { mask: true })
  const first = d.feed(frame.subarray(0, 100))
  assert.equal(first.length, 0)
  const rest = d.feed(frame.subarray(100))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].opcode, OPCODE.BINARY)
  assert.equal(rest[0].payload.length, 3200)
  assert.equal(rest[0].payload[1234], 7)
  const text = d.feed(encodeFrame('{"type":"finish"}', OPCODE.TEXT, { mask: true }))
  assert.equal(text[0].payload.toString(), '{"type":"finish"}')
})

test('fragmented text messages are reassembled', () => {
  const d = new FrameDecoder()
  const a = encodeFrame('hel', OPCODE.TEXT)
  a[0] &= 0x7f // clear FIN
  const b = encodeFrame('lo', OPCODE.CONTINUATION)
  assert.equal(d.feed(a).length, 0)
  const out = d.feed(b)
  assert.equal(out.length, 1)
  assert.equal(out[0].payload.toString(), 'hello')
})
