import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revealWords } from '../src/app/typewriter.ts'

test('revealWords spends a character budget on whole words', () => {
  const target = 'The directory has twelve entries and one markdown note from August.'
  let v = ''
  let total = 0
  let steps = 0
  let budget = 0
  while (v !== target && steps < 100) {
    budget += 6 // what one step earns at 6 cps over a second
    const r = revealWords(v, target, budget)
    budget -= r.spent
    v = r.text
    total += r.spent
    steps++
  }
  assert.equal(v, target)
  assert.equal(total, target.length)
  // ~6 chars per step over 68 chars: at least 11 steps, never a burst.
  assert.ok(steps >= 11, `only ${steps} steps`)
  assert.equal(revealWords('', target, 6).text, 'The') // "The " + "directory" would exceed 6
  assert.equal(revealWords('', target, 13).text, 'The directory')
})

test('revealWords never stalls on a long token and rewinds on divergence', () => {
  const url = 'see https://example.com/a/very/long/path/that/never/ends ok'
  const r = revealWords('see', url, 5)
  assert.equal(r.text, 'see http') // partial reveal of a >14-char token
  assert.equal(r.spent, 5)
  const stalled = revealWords('see', url, 0.5)
  assert.equal(stalled.text, 'see')
  const rewound = revealWords('Hello **wor', 'Hello world', 3)
  assert.equal(rewound.text, 'Hello ')
  assert.equal(rewound.spent, 0)
})
