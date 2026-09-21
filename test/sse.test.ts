import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SseParser } from '../src/hermes/sse.ts'

test('SseParser handles split frames, comments and event lines', () => {
  const p = new SseParser()
  const frames = [
    ...p.feed(': keepalive\n\ndata: {"event":"a"}\n\nevent: x\ndata: {"ev'),
    ...p.feed('ent":"b"}\n\n'),
    ...p.feed('data: {"event":"c"}'),
    ...p.end(),
  ]
  assert.deepEqual(
    frames.map(f => [f.event, JSON.parse(f.data).event]),
    [[undefined, 'a'], ['x', 'b'], [undefined, 'c']],
  )
})

test('SseParser joins multi-line data', () => {
  const p = new SseParser()
  const frames = p.feed('data: {"a":\ndata: 1}\n\n')
  assert.equal(frames.length, 1)
  assert.deepEqual(JSON.parse(frames[0].data), { a: 1 })
})
