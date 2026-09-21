// Cleans persisted user rows before they reach the glasses. Hermes stores a mid-turn steer as a
// role:user row whose content is wrapped in a self-describing marker (agent/prompt_builder.py), and
// it also persists synthetic control frames (compaction summaries, runtime notes) as user rows.
// Neither should be shown verbatim.

const STEER_OPEN = /\[OUT-OF-BAND USER MESSAGE[^\]]*\]/g
const STEER_CLOSE = /\[\/OUT-OF-BAND USER MESSAGE\]/g
const CONTROL_FRAME = /^\s*\[(CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT|Runtime note:|System note:|System:|SYSTEM\]|IMPORTANT:|Planning state preserved|ASYNC DELEGATION)/i

export interface CleanUserRow {
  text: string
  steer: boolean
}

/** Returns the displayable text of a user row, or null when the row is machine-generated. */
export function cleanUserRow(content: string, displayKind?: string | null): CleanUserRow | null {
  const raw = String(content ?? '')
  const steer = displayKind === 'steer' || STEER_OPEN.test(raw)
  STEER_OPEN.lastIndex = 0
  if (steer) {
    const text = raw.replace(STEER_OPEN, '').replace(STEER_CLOSE, '').trim()
    return text ? { text, steer: true } : null
  }
  if (CONTROL_FRAME.test(raw)) return null
  const text = raw.trim()
  return text ? { text, steer: false } : null
}
