import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TranscriptAccumulator, deepgramLiveUrl } from '../shared/stt-live.mjs'

const results = (transcript: string, is_final = false) => ({ type: 'Results', is_final, channel: { alternatives: [{ transcript }] } })

test('TranscriptAccumulator merges finals and keeps an interim tail', () => {
  const acc = new TranscriptAccumulator()
  assert.equal(acc.ingest(results('hello')), true)
  assert.equal(acc.text, 'hello')
  assert.equal(acc.ingest(results('hello')), false)
  assert.equal(acc.ingest(results('hello there', true)), true)
  assert.equal(acc.final, 'hello there')
  assert.equal(acc.interim, '')
  assert.equal(acc.ingest(results('how are')), true)
  assert.equal(acc.text, 'hello there how are')
  assert.equal(acc.ingest(results('how are you?', true)), true)
  assert.equal(acc.text, 'hello there how are you?')
  assert.equal(acc.ingest({ type: 'Metadata' }), false)
})

test('deepgramLiveUrl carries the PCM format and language', () => {
  const u = new URL(deepgramLiveUrl({ apiKey: 'k', language: 'en' }))
  assert.equal(u.searchParams.get('encoding'), 'linear16')
  assert.equal(u.searchParams.get('sample_rate'), '16000')
  assert.equal(u.searchParams.get('interim_results'), 'true')
  assert.equal(u.searchParams.get('language'), 'en')
  assert.equal(u.searchParams.get('model'), 'nova-3')
})
