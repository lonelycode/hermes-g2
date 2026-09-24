// Per-run context for the agent, sent as the run's `instructions` (Hermes applies it as an
// ephemeral system prompt, so it is not stored in the session history): the display the reply
// lands on, the local time and, when shared, the phone's location fix.

export interface LocationFix {
  latitude: number
  longitude: number
  /** Horizontal accuracy in metres. */
  accuracy?: number
  /** Epoch ms of the fix. */
  timestamp?: number
}

export interface ContextInput {
  now: Date
  timeZone?: string
  lines: number
  charsPerLine: number
  location?: LocationFix | null
}

export function buildInstructions(c: ContextInput): string {
  const parts = [
    `The user is talking to you by voice through Even Realities G2 smart glasses. Your reply appears on a small monochrome heads-up display that shows ${c.lines} lines of about ${c.charsPerLine} characters at a time; they can scroll, but every extra screen costs effort. Keep replies short and glanceable: lead with the answer, use a few short sentences or a compact list, and use plain text only (markdown, tables, links and images do not render). Their messages are speech-to-text transcripts and may contain recognition errors.`,
    `Current local time: ${formatTime(c.now, c.timeZone)}.`,
  ]
  if (c.location) parts.push(`User's approximate location: ${formatLocation(c.location, c.now)}.`)
  return parts.join('\n')
}

function formatTime(now: Date, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }
  let text: string
  try {
    text = new Intl.DateTimeFormat('en-GB', opts).format(now)
  } catch {
    text = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: undefined }).format(now)
    timeZone = undefined
  }
  const offset = utcOffset(now, timeZone)
  return `${text} (${[timeZone, offset].filter(Boolean).join(', ')})`
}

/** "UTC+02:00" for the given zone (or the device zone). */
function utcOffset(now: Date, timeZone?: string): string {
  let minutes = -now.getTimezoneOffset()
  if (timeZone) {
    try {
      const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(now)
        .find(p => p.type === 'timeZoneName')?.value
      const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? '')
      if (m) minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
      else if (name === 'GMT') minutes = 0
    } catch {
      /* keep the device offset */
    }
  }
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

function formatLocation(loc: LocationFix, now: Date): string {
  let text = `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`
  if (loc.accuracy && Number.isFinite(loc.accuracy)) text += ` (±${Math.round(loc.accuracy)} m)`
  if (loc.timestamp) {
    const mins = Math.round((now.getTime() - loc.timestamp) / 60000)
    if (mins >= 2) text += `, fix from ${mins} minutes ago`
  }
  return text
}
