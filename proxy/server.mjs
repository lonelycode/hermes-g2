#!/usr/bin/env node
// Hermes G2 proxy: a small CORS-clean front door for the Hermes Agent API server plus a
// speech-to-text relay that keeps your STT key off the phone.
//
//   node proxy/server.mjs
//
// GET /stt/stream is a WebSocket relay for live transcription (Deepgram): the phone streams
// 16 kHz PCM frames, the proxy forwards them to Deepgram and returns interim/final transcripts.
//
// Every request that is not /stt/* or /proxy/* is forwarded verbatim to HERMES_URL (streaming
// bodies both ways, no buffering), and every response — including the SSE run event stream —
// gets CORS headers. The Origin header is not forwarded, so the gateway's own CORS allow-list
// never has to know about the WebView's origin.
//
// Environment (see .env.example): PORT, HERMES_URL, HERMES_API_KEY, PROXY_AUTH_KEY,
// STT_PROVIDER, STT_API_KEY, STT_URL, STT_MODEL, STT_LANGUAGE, CORS_ORIGIN, SERVE_DIR.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { transcribeWithProvider } from '../shared/stt-providers.mjs'
import { openDeepgramLive } from '../shared/stt-live.mjs'
import { handshake, wrapSocket } from './ws-min.mjs'

export const CONFIG_DIR = resolve(homedir(), '.hermes-g2-proxy')
export const CONFIG_FILE = resolve(CONFIG_DIR, '.env')

loadDotEnv()

const PORT = Number(process.env.PORT || 8643)
const HOST = process.env.HOST || '0.0.0.0'
const HERMES_URL = (process.env.HERMES_URL || 'http://127.0.0.1:8642').replace(/\/+$/, '')
const HERMES_API_KEY = process.env.HERMES_API_KEY || ''
const PROXY_AUTH_KEY = process.env.PROXY_AUTH_KEY || HERMES_API_KEY
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
const STT = {
  provider: process.env.STT_PROVIDER || '',
  apiKey: process.env.STT_API_KEY || process.env.ELEVENLABS_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPGRAM_API_KEY || '',
  url: process.env.STT_URL || undefined,
  model: process.env.STT_MODEL || undefined,
  language: process.env.STT_LANGUAGE || undefined,
}
if (!STT.provider) {
  STT.provider = process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : process.env.OPENAI_API_KEY ? 'openai' : process.env.DEEPGRAM_API_KEY ? 'deepgram' : 'elevenlabs'
}
const SERVE_DIR = process.env.SERVE_DIR ? resolve(process.env.SERVE_DIR) : ''
const MAX_AUDIO_BYTES = 32 * 1024 * 1024

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'origin', 'content-length', 'accept-encoding',
])

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2',
}

function corsHeaders(req) {
  const origin = req.headers.origin
  const allow = CORS_ORIGIN === '*' ? '*' : origin && CORS_ORIGIN.split(',').map(s => s.trim()).includes(origin) ? origin : ''
  const h = {
    'Access-Control-Allow-Origin': allow || CORS_ORIGIN.split(',')[0].trim(),
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Hermes-Session-Id, X-Hermes-Session-Key, Idempotency-Key',
    'Access-Control-Expose-Headers': 'X-Hermes-Session-Key, Idempotency-Replayed, Content-Type',
    'Access-Control-Max-Age': '600',
  }
  if (allow && allow !== '*') h.Vary = 'Origin'
  return h
}

function sendJson(res, status, body, extra = {}) {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...extra })
  res.end(data)
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  return m ? m[1].trim() : ''
}

async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function handleStt(req, res, url, cors) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST audio/wav to /stt/transcribe' }, cors)
  if (PROXY_AUTH_KEY && bearer(req) !== PROXY_AUTH_KEY) return sendJson(res, 401, { error: 'proxy auth failed' }, cors)
  if (!STT.apiKey) return sendJson(res, 503, { error: `STT not configured on proxy (set STT_PROVIDER + STT_API_KEY)` }, cors)
  let wav
  try {
    wav = await readBody(req, MAX_AUDIO_BYTES)
  } catch (err) {
    return sendJson(res, 413, { error: err.message }, cors)
  }
  if (wav.length < 100) return sendJson(res, 400, { error: 'empty audio' }, cors)
  const language = url.searchParams.get('language') || STT.language
  const t0 = Date.now()
  try {
    const text = await transcribeWithProvider(new Uint8Array(wav), { ...STT, language })
    console.log(`[stt] ${STT.provider} ${wav.length}B -> ${text.length} chars in ${Date.now() - t0}ms`)
    return sendJson(res, 200, { text, provider: STT.provider }, cors)
  } catch (err) {
    console.error('[stt] failed:', err.message)
    return sendJson(res, 502, { error: err.message }, cors)
  }
}

async function handleProxyHealth(req, res, cors) {
  let hermes = 'unreachable'
  try {
    const r = await fetch(`${HERMES_URL}/health`, { signal: AbortSignal.timeout(3000) })
    hermes = r.ok ? 'ok' : `HTTP ${r.status}`
  } catch (err) {
    hermes = `unreachable (${err.message})`
  }
  sendJson(res, 200, { ok: true, hermes, hermes_url: HERMES_URL, stt: STT.apiKey ? STT.provider : 'not configured' }, cors)
}

async function forward(req, res, url, cors) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
  }
  // Client auth: when PROXY_AUTH_KEY (default HERMES_API_KEY) is set, the phone must present it;
  // the real gateway key is then injected upstream, so a stale key on the phone fails HERE with
  // a message that says so, instead of surfacing as a gateway 401.
  const isPublic = url.pathname === '/health' || url.pathname === '/v1/health'
  if (PROXY_AUTH_KEY && !isPublic) {
    const token = bearer(req)
    if (token !== PROXY_AUTH_KEY) {
      console.warn(`[proxy] ${req.method} ${url.pathname} rejected: client key ${token ? `${token.length} chars, does not match PROXY_AUTH_KEY (${PROXY_AUTH_KEY.length} chars)` : 'missing'}`)
      return sendJson(res, 401, { error: { message: `Proxy rejected the key sent by the app (${token ? `${token.length} chars` : 'none'}); it must equal PROXY_AUTH_KEY/HERMES_API_KEY on the proxy`, type: 'proxy_auth_error', code: 'proxy_auth_failed' } }, cors)
    }
  }
  if (HERMES_API_KEY) headers.authorization = `Bearer ${HERMES_API_KEY}`
  const hasBody = !['GET', 'HEAD'].includes(req.method)
  let upstream
  try {
    upstream = await fetch(`${HERMES_URL}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
    })
  } catch (err) {
    console.error(`[proxy] ${req.method} ${url.pathname} -> upstream error: ${err.message}`)
    return sendJson(res, 502, { error: { message: `Hermes unreachable at ${HERMES_URL}: ${err.message}`, type: 'proxy_error' } }, cors)
  }
  const out = { ...cors }
  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase()
    if (HOP_BY_HOP.has(key) || key === 'content-encoding' || key.startsWith('access-control-')) continue
    out[key] = v
  }
  const isSse = /text\/event-stream/i.test(upstream.headers.get('content-type') || '')
  if (isSse) {
    out['cache-control'] = 'no-cache'
    out['x-accel-buffering'] = 'no'
  }
  res.writeHead(upstream.status, out)
  if (isSse) res.flushHeaders?.()
  if (!upstream.body || req.method === 'HEAD') return res.end()
  const reader = upstream.body.getReader()
  const onClose = () => reader.cancel().catch(() => {})
  req.on('close', onClose)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!res.write(value)) await new Promise(r => res.once('drain', r))
    }
  } catch (err) {
    console.error(`[proxy] stream ${url.pathname}: ${err.message}`)
  } finally {
    req.off('close', onClose)
    res.end()
  }
}

async function serveStatic(req, res, url, cors) {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(SERVE_DIR, rel)
  if (!file.startsWith(SERVE_DIR)) return sendJson(res, 403, { error: 'forbidden' }, cors)
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(SERVE_DIR, 'index.html') // SPA fallback
  }
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length, ...cors })
    res.end(data)
  } catch {
    sendJson(res, 404, { error: 'not found' }, cors)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://proxy')
  const cors = corsHeaders(req)
  const t0 = Date.now()
  res.on('finish', () => {
    if (!url.pathname.startsWith('/stt')) console.log(`[proxy] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`)
  })
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    if (url.pathname === '/stt/transcribe') return await handleStt(req, res, url, cors)
    if (url.pathname === '/proxy/health') return await handleProxyHealth(req, res, cors)
    const isApi = /^\/(v1|api|health)(\/|$)/.test(url.pathname)
    if (SERVE_DIR && !isApi && req.method === 'GET') return await serveStatic(req, res, url, cors)
    return await forward(req, res, url, cors)
  } catch (err) {
    console.error('[proxy] handler error:', err)
    if (!res.headersSent) sendJson(res, 500, { error: err.message }, cors)
    else res.end()
  }
})

// ---- live transcription relay ---------------------------------------------------------------
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', 'http://proxy')
  if (url.pathname !== '/stt/stream') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  const token = url.searchParams.get('token') || ''
  if (PROXY_AUTH_KEY && token !== PROXY_AUTH_KEY) {
    console.warn(`[stt-live] rejected: client token ${token ? `${token.length} chars` : 'missing'}`)
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  if (!handshake(req, socket)) return socket.destroy()
  const client = wrapSocket(socket, {
    onMessage: (data, isBinary) => {
      if (isBinary) dg?.sendPcm(data)
      else if (/"finish"/.test(String(data))) {
        finishing = true
        if (dg) dg.finish()
        else done('')
      }
    },
    onClose: () => dg?.close(),
    onError: err => console.error('[stt-live] client socket error:', err.message),
  })
  const sendJson = obj => client.send(JSON.stringify(obj))
  let finishing = false
  let finished = false
  const done = final => {
    if (finished) return
    finished = true
    sendJson({ type: 'done', final })
    client.close()
  }
  if (STT.provider !== 'deepgram' || !STT.apiKey) {
    sendJson({ type: 'error', message: `live transcription needs STT_PROVIDER=deepgram on the proxy (current: ${STT.apiKey ? STT.provider : 'not configured'})` })
    return client.close(1011, 'unsupported')
  }
  const language = url.searchParams.get('language') || STT.language
  const t0 = Date.now()
  let frames = 0
  let dg
  try {
    dg = openDeepgramLive({ apiKey: STT.apiKey, url: STT.url && /^wss?:/.test(STT.url) ? STT.url : undefined, model: STT.model, language }, {
      onOpen: () => console.log('[stt-live] deepgram connected'),
      onRaw: msg => { if (process.env.STT_LIVE_DEBUG) console.log('[stt-live] <-', JSON.stringify(msg).slice(0, 300)) },
      onTranscript: t => sendJson({ type: 'transcript', final: t.final, interim: t.interim }),
      onError: err => {
        console.error('[stt-live] deepgram error:', err?.message || err)
        sendJson({ type: 'error', message: String(err?.message || err) })
      },
      onClose: ({ final, code, reason }) => {
        console.log(`[stt-live] deepgram closed (${code || ''} ${reason || ''}) after ${frames} frames, ${Date.now() - t0}ms -> ${final.length} chars`)
        if (!finishing) sendJson({ type: 'error', message: `Deepgram closed early (${code || 'no code'} ${reason || ''})`.trim() })
        done(final)
      },
    })
    const rawSend = dg.sendPcm
    dg.sendPcm = pcm => {
      frames++
      rawSend(pcm)
    }
  } catch (err) {
    sendJson({ type: 'error', message: err.message })
    client.close(1011, 'deepgram')
  }
})

export function start() {
  server.listen(PORT, HOST, () => {
  console.log(`[proxy] listening on http://${HOST}:${PORT}`)
  console.log(`[proxy] forwarding to ${HERMES_URL}${HERMES_API_KEY ? ` (injecting gateway key upstream; clients must send the ${PROXY_AUTH_KEY.length}-char PROXY_AUTH_KEY)` : ' (passing client keys through)'}`)
  console.log(`[proxy] STT: ${STT.apiKey ? STT.provider + (STT.model ? ` (${STT.model})` : '') : 'not configured'}${PROXY_AUTH_KEY ? ', bearer-protected' : ', OPEN — set PROXY_AUTH_KEY'}${STT.provider === 'deepgram' && STT.apiKey ? ', live relay at ws://.../stt/stream' : ''}`)
  if (SERVE_DIR) console.log(`[proxy] serving static files from ${SERVE_DIR}`)
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start()

/** Config precedence: HERMES_G2_PROXY_ENV, then the repo .env, cwd .env, then ~/.hermes-g2-proxy/.env. */
export function envFileCandidates() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const list = []
  if (process.env.HERMES_G2_PROXY_ENV) list.push(resolve(process.env.HERMES_G2_PROXY_ENV))
  list.push(resolve(here, '..', '.env'), resolve(process.cwd(), '.env'), CONFIG_FILE)
  return list
}

function loadDotEnv() {
  for (const candidate of envFileCandidates()) {
    if (!existsSync(candidate)) continue
    process.env.HERMES_G2_PROXY_LOADED_ENV = candidate
    for (const line of readFileSync(candidate, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m || m[1] in process.env) continue
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
    break
  }
}
