import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeToolCall, summarizeToolResult, looksLikeError } from '../src/app/summaries.ts'

test('summarizeToolCall picks the meaningful argument', () => {
  assert.equal(summarizeToolCall('terminal', '{"command": "ls -la ~/projects", "timeout": 30}'), 'terminal: ls -la ~/projects')
  assert.equal(summarizeToolCall('web_search', '{"query":"fibre plans whangaparaoa","max_results":5}'), 'web_search: fibre plans whangaparaoa')
  assert.equal(summarizeToolCall('read_file', '{"path":"/srv/app/config.yaml"}'), 'read_file: /srv/app/config.yaml')
})

test('summarizeToolCall copes with truncated JSON, arrays and plain text', () => {
  assert.equal(summarizeToolCall('write_file', '{"path": "/tmp/x.txt", "content": "a very long file body that got cut'), 'write_file: /tmp/x.txt')
  assert.equal(summarizeToolCall('batch', '[1,2,3]'), 'batch (3 items)')
  assert.equal(summarizeToolCall('terminal', 'terminal: git status'), 'terminal: git status')
  assert.equal(summarizeToolCall('terminal', ''), 'terminal')
  assert.equal(summarizeToolCall('noop', '{"flag": true}'), 'noop: true')
})

test('summarizeToolCall truncates long values', () => {
  const s = summarizeToolCall('terminal', JSON.stringify({ command: 'x'.repeat(200) }), 40)
  assert.ok(s.length <= 'terminal: '.length + 40)
  assert.ok(s.endsWith('…'))
})

test('summarizeToolResult and looksLikeError', () => {
  assert.equal(summarizeToolResult('{"stdout":"total 48\\ndrwxr-xr-x","exit_code":0}'), 'total 48 drwxr-xr-x')
  assert.equal(summarizeToolResult('[{"a":1},{"a":2}]'), '2 results')
  assert.equal(summarizeToolResult('plain text result\nsecond line', 12), 'plain text …')
  assert.equal(looksLikeError('{"error":"ENOENT: no such file"}'), true)
  assert.equal(looksLikeError('all good'), false)
})
