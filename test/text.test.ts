import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTextWidth } from '@evenrealities/pretext'
import { wrapText, plainify, fitLine, oneLine } from '../src/glasses/text.ts'

test('wrapText keeps every line within the pixel budget', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(12) + 'Supercalifragilisticexpialidocious'.repeat(4)
  const lines = wrapText(text, 568)
  assert.ok(lines.length > 5)
  for (const line of lines) assert.ok(getTextWidth(line) <= 568, `too wide: ${line}`)
})

test('wrapText honours explicit newlines and blank lines', () => {
  assert.deepEqual(wrapText('a\n\nb', 568), ['a', '', 'b'])
})

test('plainify strips markdown decorations', () => {
  const md = '# Title\n\nSome **bold** and *italic* with `code` and a [link](http://x).\n\n- item one\n- item two\n\n```sh\nls -la\n```'
  const out = plainify(md)
  assert.equal(out.includes('#'), false)
  assert.equal(out.includes('**'), false)
  assert.ok(out.includes('bold'))
  assert.ok(out.includes('• item one'))
  assert.ok(out.includes('ls -la'))
  assert.ok(out.includes('link'))
  assert.equal(out.includes('http://x'), false)
})

test('fitLine truncates with an ellipsis and oneLine collapses whitespace', () => {
  const s = fitLine('x'.repeat(300), 200)
  assert.ok(getTextWidth(s) <= 200)
  assert.ok(s.endsWith('...'))
  assert.equal(oneLine('  a\n\n b\t c  ', 10), 'a b c')
  assert.equal(oneLine('abcdefghijklmnop', 6), 'abcde…')
})
