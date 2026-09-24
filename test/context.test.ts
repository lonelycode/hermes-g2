import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInstructions } from '../src/app/context.ts'

test('instructions describe the display, the local time and the location', () => {
  const now = new Date('2026-09-25T13:05:00Z')
  const text = buildInstructions({
    now,
    timeZone: 'Europe/London',
    lines: 9,
    charsPerLine: 52,
    location: { latitude: 51.50735, longitude: -0.12776, accuracy: 18.4, timestamp: now.getTime() - 10 * 60000 },
  })
  assert.match(text, /9 lines of about 52 characters/)
  // ICU punctuation varies between runtimes; pin the parts that matter.
  assert.match(text, /Friday,? 25 September 2026,? (at )?14:05 \(Europe\/London, UTC\+01:00\)/)
  assert.match(text, /51\.50735, -0\.12776 \(±18 m\), fix from 10 minutes ago/)
})

test('no location line without a fix', () => {
  const text = buildInstructions({ now: new Date(), timeZone: 'UTC', lines: 9, charsPerLine: 52 })
  assert.doesNotMatch(text, /location/i)
})

test('chart instructions only when charts are on', () => {
  const on = buildInstructions({ now: new Date(), timeZone: 'UTC', lines: 9, charsPerLine: 52, charts: true })
  assert.match(on, /```g2chart\n\{"type":"bar"/)
  assert.match(on, /exception is the chart block/)
  const off = buildInstructions({ now: new Date(), timeZone: 'UTC', lines: 9, charsPerLine: 52 })
  assert.doesNotMatch(off, /g2chart/)
})
