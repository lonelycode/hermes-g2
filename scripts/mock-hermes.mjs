#!/usr/bin/env node
// A stand-in for the Hermes Agent API server so the glasses app can be exercised in the
// simulator without a real gateway. Implements the subset the app uses: health, capabilities,
// sessions (list/create/messages), runs (create/status/events SSE/approval/steer/stop).
//
//   node scripts/mock-hermes.mjs            # http://127.0.0.1:8642, key "mock"
//   MOCK_BROKEN_SSE_CORS=1 node scripts/mock-hermes.mjs   # reproduce the stock gateway's missing SSE CORS
//
// Say "approve" in a message to trigger an approval request; "fail" to make the run fail;
// "slow" for a long-running run you can steer or stop.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT || 8642)
const KEY = process.env.API_SERVER_KEY || 'mock'
const BROKEN_SSE_CORS = process.env.MOCK_BROKEN_SSE_CORS === '1'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Hermes-Session-Id, X-Hermes-Session-Key',
  'Access-Control-Max-Age': '600',
}

const sessions = new Map()
const messages = new Map()
const runs = new Map()

function seedSession(id, title, msgs) {
  const now = Date.now() / 1000
  sessions.set(id, { id, title, source: 'api_server', started_at: now - 3600, last_active: now - 60, message_count: msgs.length, preview: msgs[0]?.content })
  messages.set(id, msgs.map((m, i) => ({ id: i + 1, session_id: id, timestamp: now - 3600 + i * 10, ...m })))
}
seedSession('mock_alpha', 'Broadband comparison', [
  { role: 'user', content: 'Compare fibre plans for 859 Whangaparaoa' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{"query":"fibre plans whangaparaoa"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'results…' },
  { role: 'assistant', content: 'Here is a **short** comparison:\n\n- Plan A: 300/100 at $79\n- Plan B: 900/500 at $99\n\nPlan B is better value if you upload a lot.' },
])
seedSession('mock_beta', 'Server maintenance', [
  { role: 'user', content: 'Check disk usage on the gateway host' },
  { role: 'assistant', content: 'Disk usage is at 41%. Nothing to worry about.' },
])

function json(res, status, body, extra = {}) {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...CORS, ...extra })
  res.end(data)
}
function error(res, status, message, code) {
  json(res, status, { error: { message, type: code || 'invalid_request_error', code } })
}
async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function pushEvent(run, event, fields = {}) {
  const ev = { event, run_id: run.id, timestamp: Date.now() / 1000, ...fields }
  run.last_event = event
  for (const sub of run.subscribers) sub(ev)
  if (event.startsWith('run.')) for (const sub of run.subscribers) sub(null)
}

async function executeRun(run, input) {
  run.status = 'running'
  const lower = input.toLowerCase()
  await sleep(300)
  pushEvent(run, 'message.interim', { text: 'Let me look into that.', already_streamed: false })
  await sleep(400)
  pushEvent(run, 'tool.started', { tool: 'terminal', preview: `ls -la ~/projects | head` })
  await sleep(900)
  pushEvent(run, 'tool.completed', { tool: 'terminal', duration: 0.87, error: false, preview: 'total 48\ndrwxr-xr-x  12 martin staff  384 Sep 21 18:22 .\n-rw-r--r--   1 martin staff 1483 Aug 25 10:22 notes.md' })
  if (lower.includes('approve')) {
    run.status = 'waiting_for_approval'
    run.approval = {
      event: 'approval.request', run_id: run.id, timestamp: Date.now() / 1000,
      command: 'rm -rf build/ && npm run deploy --prod',
      description: 'Run a destructive shell command',
      pattern_key: 'rm -rf', request_id: `req_${randomUUID().slice(0, 8)}`,
      choices: ['once', 'session', 'always', 'deny'], allow_session: true, allow_permanent: true,
    }
    pushEvent(run, 'approval.request', run.approval)
    const decision = await new Promise(resolve => { run.resolveApproval = resolve })
    run.approval = null
    run.status = 'running'
    pushEvent(run, 'approval.responded', { choice: decision })
    if (decision === 'deny') {
      await sleep(300)
      return finish(run, 'completed', 'Understood — I did not run the deploy command. Tell me if you want a dry run instead.')
    }
  }
  if (lower.includes('fail')) {
    await sleep(300)
    return finish(run, 'failed', undefined, 'provider returned HTTP 500: simulated failure')
  }
  await sleep(300)
  pushEvent(run, 'subagent.start', { goal: 'Summarise the directory listing', task_index: 0, task_count: 1 })
  await sleep(lower.includes('slow') ? 6000 : 800)
  if (run.stopped) return finish(run, 'cancelled')
  pushEvent(run, 'subagent.complete', { status: 'completed', summary: 'Twelve entries, one markdown note.', duration_seconds: 0.8 })
  const answer = lower.includes('slow')
    ? `That took a while, but here it is.${run.steer ? `\n\n(You steered me with: "${run.steer}")` : ''}\n\nThe directory has 12 entries. The only document is **notes.md** from August.`
    : `You said: "${input}"\n\nThe directory has **12 entries**. The only document is notes.md (1.4 KB, Aug 25).\n\n1. Nothing needs attention\n2. Ask me to open a file if you want details`
  for (const word of answer.split(/(?<=\s)/)) {
    if (run.stopped) return finish(run, 'cancelled')
    pushEvent(run, 'message.delta', { delta: word })
    await sleep(35)
  }
  return finish(run, 'completed', answer)
}

function finish(run, status, output, err) {
  run.status = status
  if (output !== undefined) run.output = output
  if (err) run.error = err
  const fields = status === 'completed'
    ? { completed: true, partial: false, interrupted: false, output, usage: { input_tokens: 50, output_tokens: 120, total_tokens: 170 } }
    : status === 'failed' ? { completed: false, partial: false, interrupted: false, error: err }
    : { completed: false, partial: true, interrupted: true }
  pushEvent(run, `run.${status}`, fields)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock')
  if (req.method === 'OPTIONS') { res.writeHead(200, CORS); return res.end() }
  const path = url.pathname
  console.log(`[mock] ${req.method} ${path}`)
  if (path === '/health' || path === '/v1/health') return json(res, 200, { status: 'ok' })
  const auth = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '')?.[1]
  if (auth !== KEY) return json(res, 401, { error: { message: 'Invalid gateway API key (API_SERVER_KEY)', type: 'gateway_auth_error' } })

  if (path === '/v1/capabilities') {
    return json(res, 200, { object: 'hermes.api_server.capabilities', platform: 'hermes-agent', model: 'mock-hermes', auth: { type: 'bearer', required: true },
      features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true, run_approval_response: true, approval_events: true, tool_progress_events: true } })
  }
  if (path === '/api/sessions' && req.method === 'GET') {
    const data = [...sessions.values()].sort((a, b) => b.last_active - a.last_active)
    return json(res, 200, { object: 'list', data, limit: 50, offset: 0, has_more: false })
  }
  if (path === '/api/sessions' && req.method === 'POST') {
    const b = await body(req)
    const id = b.id || b.session_id || `api_${Date.now()}_${randomUUID().slice(0, 8)}`
    if (sessions.has(id)) return error(res, 409, `Session already exists: ${id}`, 'session_exists')
    const s = { id, title: b.title || null, source: 'api_server', started_at: Date.now() / 1000, last_active: Date.now() / 1000, message_count: 0 }
    sessions.set(id, s); messages.set(id, [])
    return json(res, 201, s)
  }
  let m
  if ((m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path))) {
    const id = decodeURIComponent(m[1])
    if (!sessions.has(id)) return error(res, 404, `Session not found: ${id}`, 'session_not_found')
    const data = messages.get(id) || []
    return json(res, 200, { object: 'list', session_id: id, data, pagination: { limit: 500, offset: 0, order: 'latest', returned: data.length } })
  }
  if ((m = /^\/api\/sessions\/([^/]+)$/.exec(path)) && req.method === 'PATCH') {
    const id = decodeURIComponent(m[1]); const s = sessions.get(id)
    if (!s) return error(res, 404, 'Session not found', 'session_not_found')
    Object.assign(s, await body(req)); return json(res, 200, s)
  }
  if (path === '/v1/runs' && req.method === 'POST') {
    const b = await body(req)
    if (!b.input) return error(res, 400, "Missing 'input' field")
    const sessionId = b.session_id || `run_${randomUUID().hex}`
    if (!sessions.has(sessionId)) { sessions.set(sessionId, { id: sessionId, title: null, source: 'api_server', started_at: Date.now() / 1000, last_active: Date.now() / 1000 }); messages.set(sessionId, []) }
    const run = { id: `run_${randomUUID().replace(/-/g, '')}`, session_id: sessionId, status: 'queued', subscribers: new Set(), created_at: Date.now() / 1000, output: '', steer: '' }
    runs.set(run.id, run)
    const msgs = messages.get(sessionId); msgs.push({ id: msgs.length + 1, role: 'user', content: b.input, timestamp: Date.now() / 1000 })
    sessions.get(sessionId).last_active = Date.now() / 1000
    setTimeout(() => executeRun(run, b.input).then(() => { if (run.output) msgs.push({ id: msgs.length + 1, role: 'assistant', content: run.output, timestamp: Date.now() / 1000 }) }).catch(err => console.error(err)), 50)
    return json(res, 202, { run_id: run.id, status: 'started', replayed: false })
  }
  if ((m = /^\/v1\/runs\/([^/]+)$/.exec(path)) && req.method === 'GET') {
    const run = runs.get(m[1]); if (!run) return error(res, 404, `Run not found: ${m[1]}`, 'run_not_found')
    return json(res, 200, { object: 'hermes.run', run_id: run.id, status: run.status, session_id: run.session_id, model: 'mock-hermes', output: run.output, error: run.error, last_event: run.last_event, approval: run.approval || undefined })
  }
  if ((m = /^\/v1\/runs\/([^/]+)\/events$/.exec(path))) {
    const run = runs.get(m[1]); if (!run) return error(res, 404, `Run not found: ${m[1]}`, 'run_not_found')
    const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }
    if (!BROKEN_SSE_CORS) Object.assign(headers, CORS)
    res.writeHead(200, headers); res.flushHeaders()
    const sub = ev => { if (ev === null) { res.write(': stream closed\n\n'); res.end(); run.subscribers.delete(sub); clearInterval(ka) } else res.write(`data: ${JSON.stringify(ev)}\n\n`) }
    const ka = setInterval(() => res.write(': keepalive\n\n'), 10000)
    run.subscribers.add(sub)
    if (['completed', 'failed', 'cancelled'].includes(run.status)) sub({ event: `run.${run.status}`, run_id: run.id, output: run.output, error: run.error }), sub(null)
    req.on('close', () => { run.subscribers.delete(sub); clearInterval(ka) })
    return
  }
  if ((m = /^\/v1\/runs\/([^/]+)\/approval$/.exec(path)) && req.method === 'POST') {
    const run = runs.get(m[1]); if (!run) return error(res, 404, 'Run not found', 'run_not_found')
    const b = await body(req); const choice = { approve: 'once', allow: 'once' }[b.choice] || b.choice
    if (!['once', 'session', 'always', 'deny'].includes(choice)) return error(res, 400, 'Invalid approval choice', 'invalid_approval_choice')
    if (!run.resolveApproval) return error(res, 409, `Run has no pending approval: ${run.id}`, 'approval_not_pending')
    const resolve = run.resolveApproval; run.resolveApproval = null; resolve(choice)
    return json(res, 200, { object: 'hermes.run.approval_response', run_id: run.id, choice, resolved: 1 })
  }
  if ((m = /^\/v1\/runs\/([^/]+)\/steer$/.exec(path)) && req.method === 'POST') {
    const run = runs.get(m[1]); if (!run) return error(res, 404, 'Run not found', 'run_not_found')
    if (run.status !== 'running') return error(res, 409, `Run is not currently accepting steer input: ${run.id}`, 'run_not_accepting_steer')
    const b = await body(req); run.steer = b.input || b.message || b.text || ''
    pushEvent(run, 'run.steered', { accepted: true })
    return json(res, 200, { object: 'hermes.run.steer', run_id: run.id, accepted: true })
  }
  if ((m = /^\/v1\/runs\/([^/]+)\/stop$/.exec(path)) && req.method === 'POST') {
    const run = runs.get(m[1]); if (!run) return error(res, 404, 'Run not found', 'run_not_found')
    run.stopped = true
    if (run.resolveApproval) { const r = run.resolveApproval; run.resolveApproval = null; r('deny') }
    return json(res, 200, { run_id: run.id, status: 'stopping' })
  }
  error(res, 404, `No route: ${req.method} ${path}`)
})
server.listen(PORT, '127.0.0.1', () => console.log(`[mock] Hermes mock on http://127.0.0.1:${PORT} (key: ${KEY})${BROKEN_SSE_CORS ? ' — SSE CORS deliberately broken' : ''}`))
