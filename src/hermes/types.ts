// Wire types for the Hermes Agent API server (gateway/platforms/api_server*.py).

export interface HermesSession {
  id: string
  source?: string
  title?: string | null
  preview?: string | null
  started_at?: number
  ended_at?: number | null
  last_active?: number | null
  message_count?: number
  parent_session_id?: string | null
  pinned?: boolean
  archived?: boolean
}

export interface HermesMessage {
  id?: number | string
  session_id?: string
  role: 'user' | 'assistant' | 'system' | 'tool' | string
  content?: string | null | Array<{ type: string; text?: string }>
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> | null
  tool_name?: string | null
  tool_call_id?: string | null
  timestamp?: number
  display_kind?: string
}

export type RunStatusName =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface RunStatus {
  object?: 'hermes.run'
  run_id: string
  status: RunStatusName
  session_id?: string
  model?: string
  output?: string
  error?: string
  last_event?: string
  approval?: ApprovalRequestEvent
  pending_steer?: string
  usage?: Record<string, number>
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

interface BaseEvent {
  event: string
  run_id: string
  timestamp?: number
}

export interface MessageDeltaEvent extends BaseEvent {
  event: 'message.delta'
  delta: string
}
export interface MessageInterimEvent extends BaseEvent {
  event: 'message.interim'
  text: string
  already_streamed?: boolean
}
export interface ToolStartedEvent extends BaseEvent {
  event: 'tool.started'
  tool: string
  preview?: string | null
}
export interface ToolCompletedEvent extends BaseEvent {
  event: 'tool.completed'
  tool: string
  duration?: number
  error?: boolean
  preview?: string
}
export interface ReasoningEvent extends BaseEvent {
  event: 'reasoning.available'
  text: string
}
export interface SubagentEvent extends BaseEvent {
  event: 'subagent.start' | 'subagent.complete'
  goal?: string
  summary?: string
  status?: string
  preview?: string
  duration_seconds?: number
  task_index?: number
  task_count?: number
}
export interface ApprovalRequestEvent extends BaseEvent {
  event: 'approval.request'
  command?: string
  description?: string
  pattern_key?: string
  pattern_keys?: string[]
  request_id?: string
  choices: ApprovalChoice[]
  smart_denied?: boolean
  allow_session?: boolean
  allow_permanent?: boolean
}
export interface ApprovalRespondedEvent extends BaseEvent {
  event: 'approval.responded'
  choice: ApprovalChoice
  request_id?: string
  resolved?: number
}
export interface RunTerminalEvent extends BaseEvent {
  event: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted'
  output?: string
  error?: string
  completed?: boolean
  partial?: boolean
  pending_steer?: string
  usage?: Record<string, number>
}
export interface RunSteeredEvent extends BaseEvent {
  event: 'run.steered'
  accepted?: boolean
}

export type RunEvent =
  | MessageDeltaEvent
  | MessageInterimEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ReasoningEvent
  | SubagentEvent
  | ApprovalRequestEvent
  | ApprovalRespondedEvent
  | RunTerminalEvent
  | RunSteeredEvent

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
])
