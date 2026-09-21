import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pcmToWav, pcmStats, concatChunks } from '../src/stt/wav.ts'

test('pcmToWav writes a valid 44-byte RIFF header', () => {
  const pcm = new Uint8Array(3200)
  const wav = pcmToWav(pcm)
  assert.equal(wav.byteLength, 44 + 3200)
  const v = new DataView(wav.buffer)
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE')
  assert.equal(v.getUint32(24, true), 16000)
  assert.equal(v.getUint16(22, true), 1)
  assert.equal(v.getUint32(40, true), 3200)
})

test('pcmStats separates silence from signal', () => {
  const silent = new Uint8Array(32000)
  assert.equal(pcmStats(silent).rms, 0)
  assert.equal(pcmStats(silent).seconds, 1)
  const loud = new Uint8Array(32000)
  const dv = new DataView(loud.buffer)
  for (let i = 0; i < 16000; i++) dv.setInt16(i * 2, Math.round(8000 * Math.sin(i / 10)), true)
  const s = pcmStats(concatChunks([loud.slice(0, 16000), loud.slice(16000)]))
  assert.ok(s.rms > 4000)
  assert.ok(s.peak <= 8000 && s.peak > 7000)
})
