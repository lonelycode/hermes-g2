import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextReveal } from '../src/app/typewriter.ts'

test('nextReveal grows by whole words and finishes cleanly', () => {
  const target = 'The directory has twelve entries and one markdown note from August.'
  let v = ''
  const steps: string[] = []
  for (let i = 0; i < 20 && v !== target; i++) {
    v = nextReveal(v, target, 10)
    steps.push(v)
  }
  assert.equal(v, target)
  for (const s of steps.slice(0, -1)) assert.ok(/\s$|[^\s]$/.test(s) && target.startsWith(s) && !/[a-z]$/i.test(s.slice(-1)) === false || target.startsWith(s))
  assert.ok(steps.length >= 4 && steps.length < 12, `took ${steps.length} steps`)
  assert.equal(steps[0], 'The directory') // 10 chars, extended to the word boundary
})

test('nextReveal jumps when the target diverges or the tail is short', () => {
  assert.equal(nextReveal('Hello wor', 'Goodbye', 5), 'Goodbye')
  assert.equal(nextReveal('abc', 'abc def', 3), 'abc def')
  assert.equal(nextReveal('same', 'same', 5), 'same')
  assert.equal(nextReveal('', 'x'.repeat(100), 0), 'x'.repeat(100))
})
