import { SseParser } from './sse.ts'
import type {
  ApprovalChoice,
  HermesMessage,
  HermesSession,
  RunEvent,
  RunStatus,
} from './types.ts'

export class HermesError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'auth' | 'http' | 'protocol',
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'HermesError'
  }
}

export interface HermesClientOptions {
  baseUrl: string
  apiKey: string
  /** Optional long-term memory scope forwarded as X-Hermes-Session-Key. */
  sessionKey?: string
  fetchImpl?: typeof fetch
}

/**
 * Thin client for the Hermes Agent API server: sessions, runs, SSE run events, approvals,
 * steering and stop. Every request carries the bearer key; SSE is read via fetch streaming.
 */
export class HermesClient {
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly sessionKey?: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: HermesClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.sessionKey = opts.sessionKey
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', ...extra }
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`
    if (this.sessionKey) h['X-Hermes-Session-Key'] = this.sessionKey
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      })
    } catch (err) {
      throw new HermesError(describeNetworkError(err), 'network')
    }
    if (!res.ok) throw await this.httpError(res)
    const text = await res.text()
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new HermesError(`Non-JSON response from ${path}`, 'protocol', res.status)
    }
  }

  private async httpError(res: Response): Promise<HermesError> {
    let message = `HTTP ${res.status}`
    let code: string | undefined
    try {
      const json = await res.json()
      const err = json?.error
      if (typeof err === 'string') message = err
      else if (err?.message) message = String(err.message)
      code = err?.code ?? err?.type
    } catch {
      /* not JSON */
    }
    const kind = res.status === 401 || res.status === 403 ? 'auth' : 'http'
    return new HermesError(message, kind, res.status, code)
  }

  // ---- discovery -----------------------------------------------------------------------------

  health(): Promise<{ status: string }> {
    return this.request('GET', '/health')
  }

  capabilities(): Promise<Record<string, unknown>> {
    return this.request('GET', '/v1/capabilities')
  }

  // ---- sessions ------------------------------------------------------------------------------

  async listSessions(limit = 19): Promise<HermesSession[]> {
    const json = await this.request<{ data?: HermesSession[] }>('GET', `/api/sessions?limit=${limit}`)
    return Array.isArray(json.data) ? json.data : []
  }

  createSession(title: string): Promise<HermesSession> {
    return this.request('POST', '/api/sessions', { title, source: 'api_server' })
  }

  async getMessages(sessionId: string, limit = 60): Promise<HermesMessage[]> {
    const json = await this.request<{ data?: HermesMessage[] }>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&order=latest`,
    )
    const data = Array.isArray(json.data) ? json.data : []
    // "latest" pages come newest-first from some builds; normalise to chronological order.
    if (data.length > 1) {
      const a = data[0].timestamp ?? 0
      const b = data[data.length - 1].timestamp ?? 0
      if (a > b) data.reverse()
    }
    return data
  }

  renameSession(sessionId: string, title: string): Promise<HermesSession> {
    return this.request('PATCH', `/api/sessions/${encodeURIComponent(sessionId)}`, { title })
  }

  // ---- runs ----------------------------------------------------------------------------------

  createRun(input: string, sessionId: string): Promise<{ run_id: string; status: string }> {
    return this.request('POST', '/v1/runs', { input, session_id: sessionId, stream: false })
  }

  getRun(runId: string): Promise<RunStatus> {
    return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}`)
  }

  approve(runId: string, choice: ApprovalChoice, requestId?: string): Promise<unknown> {
    const body: Record<string, unknown> = { choice }
    if (requestId) body.request_id = requestId
    return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/approval`, body)
  }

  steer(runId: string, text: string): Promise<{ accepted: boolean }> {
    return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/steer`, { input: text })
  }

  stop(runId: string): Promise<{ status: string }> {
    return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, {})
  }

  /**
   * Stream run events until the server closes the stream or `signal` aborts.
   * Resolves normally on a clean close; rejects with HermesError on connection failure.
   * A missing CORS header on this endpoint surfaces as a `network` error before any event.
   */
  async streamRunEvents(
    runId: string,
    onEvent: (event: RunEvent) => void,
    signal?: AbortSignal,
    onOpen?: () => void,
  ): Promise<void> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
        method: 'GET',
        headers: this.headers({ Accept: 'text/event-stream' }),
        signal,
      })
    } catch (err) {
      if (signal?.aborted) return
      throw new HermesError(describeNetworkError(err), 'network')
    }
    if (!res.ok) throw await this.httpError(res)
    if (!res.body) throw new HermesError('Event stream has no body', 'protocol', res.status)
    onOpen?.()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    const emit = (frames: ReturnType<SseParser['feed']>) => {
      for (const f of frames) {
        let payload: unknown
        try {
          payload = JSON.parse(f.data)
        } catch {
          continue
        }
        if (payload && typeof payload === 'object') {
          const ev = payload as RunEvent
          if (!ev.event && f.event) (ev as { event: string }).event = f.event
          if (ev.event) onEvent(ev)
        }
      }
    }
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        emit(parser.feed(decoder.decode(value, { stream: true })))
      }
      emit(parser.end())
    } catch (err) {
      if (signal?.aborted) return
      throw new HermesError(describeNetworkError(err), 'network')
    }
  }
}

function describeNetworkError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|Load failed|NetworkError|network error/i.test(msg)) {
    return `Network/CORS failure (${msg}). Check the URL, the app.json whitelist and that the gateway sends CORS headers (or use the proxy).`
  }
  return msg
}
