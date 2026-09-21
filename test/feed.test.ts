import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Feed } from '../src/app/feed.ts'

test('feed pages, follows the tail and scrolls back', () => {
  const feed = new Feed(568, 4)
  feed.add('user', 'hello')
  const a = feed.add('assistant', '')
  for (let i = 0; i < 12; i++) feed.append(a, `line ${i}\n`)
  const lines = feed.lines()
  assert.ok(lines.length >= 13)
  const pos = feed.position()
  assert.equal(pos.atEnd, true)
  assert.equal(pos.follow, true)
  assert.ok(feed.page().includes('line 11'))
  assert.equal(feed.scrollUp(), true)
  assert.equal(feed.position().follow, false)
  assert.equal(feed.page().includes('line 11'), false)
  while (feed.scrollDown()) {
    /* to the end */
  }
  assert.equal(feed.position().follow, true)
  assert.ok(feed.page().includes('line 11'))
})

test('tool entries update in place and user turns get a separator', () => {
  const feed = new Feed(568, 9)
  feed.add('user', 'first')
  const t = feed.add('tool', 'terminal ls', { tool: 'terminal' })
  assert.equal(feed.openTool('terminal'), t)
  feed.update(t, { text: 'terminal 0.5s', done: true })
  assert.equal(feed.openTool('terminal'), undefined)
  feed.add('user', 'second')
  const lines = feed.lines()
  assert.equal(lines[0], '▶ first')
  assert.equal(lines[1], '● terminal 0.5s')
  assert.equal(lines[2], '')
  assert.equal(lines[3], '▶ second')
})
