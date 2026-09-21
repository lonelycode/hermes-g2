import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanUserRow } from '../src/app/history.ts'

const OPEN = '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]'

test('steer rows lose their marker and are flagged', () => {
  const row = cleanUserRow(`\n\n${OPEN}\nfocus on the README only\n[/OUT-OF-BAND USER MESSAGE]`, 'steer')
  assert.deepEqual(row, { text: 'focus on the README only', steer: true })
  const noKind = cleanUserRow(`${OPEN}\nskip tests\n[/OUT-OF-BAND USER MESSAGE]`)
  assert.deepEqual(noKind, { text: 'skip tests', steer: true })
})

test('control frames are hidden, ordinary text passes through', () => {
  assert.equal(cleanUserRow('[CONTEXT COMPACTION] summary of earlier turns …'), null)
  assert.equal(cleanUserRow('[Runtime note: budget exceeded]'), null)
  assert.equal(cleanUserRow('   '), null)
  assert.deepEqual(cleanUserRow('  what changed today  '), { text: 'what changed today', steer: false })
  assert.deepEqual(cleanUserRow('[not a control frame] hello'), { text: '[not a control frame] hello', steer: false })
})
