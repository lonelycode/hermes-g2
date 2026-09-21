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
  assert.equal(lines[0], '▶ You: first')
  assert.equal(lines[1], ' └ ● terminal 0.5s')
  assert.equal(lines[2], '')
  assert.equal(lines[3], '▶ You: second')
})

test('steps form a tree under the turn and the answer can be anchored to the top', () => {
  const feed = new Feed(568, 4)
  feed.add('user', 'question')
  feed.add('interim', 'looking')
  feed.add('tool', 'terminal ls', { tool: 'terminal', done: true })
  const answer = feed.add('assistant', 'line one\nline two\nline three\nline four')
  const lines = feed.lines()
  assert.equal(lines[1], ' ├ · looking')
  assert.equal(lines[2], ' └ ● terminal ls')
  assert.equal(lines[3], '')
  assert.equal(lines[4], '■ Hermes: line one')
  // Following: tail visible. Anchored: the answer label is the first line on the page.
  assert.ok(feed.page().includes('line four'))
  feed.anchorTo(answer)
  assert.equal(feed.page().split('\n')[0], '■ Hermes: line one')
  assert.equal(feed.anchored, true)
  feed.scrollUp()
  assert.equal(feed.anchored, false)
})
